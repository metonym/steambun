import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, resolve } from "../src/config.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A temp app folder with these files. */
function app(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "steambun-config-"));
  dirs.push(d);
  for (const [f, s] of Object.entries(files)) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    writeFileSync(join(d, f), s);
  }
  return d;
}

test("no config file: name from package.json, no core", async () => {
  const c = await loadConfig(app({ "package.json": `{"name":"notes"}` }));
  expect(c.name).toBe("Notes");
  expect(c.id).toBe("local.steambun.notes");
  expect(c.idDefault).toBe(true);
  expect(c.core).toBe(false);
  expect(c.page).toBe("index.html");
});

test("a kebab-case package name becomes PascalCase", async () => {
  const c = await loadConfig(app({ "package.json": `{"name":"todo-bar"}` }));
  expect([c.name, c.id]).toEqual(["TodoBar", "local.steambun.todobar"]);
});

test("a scoped package name drops the scope", async () => {
  const c = await loadConfig(app({ "package.json": `{"name":"@me/notes"}` }));
  expect(c.name).toBe("Notes");
});

test("core.ts at the root turns the core on", async () => {
  const c = await loadConfig(
    app({ "package.json": `{"name":"notes"}`, "core.ts": "" }),
  );
  expect(c.core).toBe("core.ts");
  expect(c.bun).toBe("bundled");
});

test("core/index.ts turns the core on too", async () => {
  const c = await loadConfig(
    app({ "package.json": `{"name":"notes"}`, "core/index.ts": "" }),
  );
  expect(c.core).toBe("core/index.ts");
});

test("core: false wins over core.ts", async () => {
  const c = await loadConfig(
    app({
      "package.json": `{"name":"notes","steambun":{"core":false}}`,
      "core.ts": "",
    }),
  );
  expect(c.core).toBe(false);
});

test("package.json's steambun object is the config", async () => {
  const c = await loadConfig(
    app({
      "package.json": `{"name":"notes","steambun":{"id":"com.x.notes","bun":"system"}}`,
    }),
  );
  expect(c.id).toBe("com.x.notes");
  expect(c.idDefault).toBe(false);
  expect(c.bun).toBe("system");
});

test("steambun.config.ts wins over package.json", async () => {
  const c = await loadConfig(
    app({
      "package.json": `{"name":"notes","steambun":{"id":"com.x.pkg"}}`,
      "steambun.config.ts": `export default { name: "Jot", id: "com.x.file" }`,
    }),
  );
  expect([c.name, c.id]).toEqual(["Jot", "com.x.file"]);
});

test("no name anywhere is an error", async () => {
  await expect(loadConfig(app({}))).rejects.toThrow(/no name/);
});

test("a menu key the shell owns is an error that names it", () => {
  const menus = (key: string) => ({
    menus: { View: [{ title: "Say Hi", command: "hi", key }] },
  });
  expect(() => resolve(menus("mod+h"), "/x", "notes")).toThrow(
    /Say Hi.*mod\+h.*Hide/,
  );
  expect(() => resolve(menus("shift+mod+Z"), "/x", "notes")).toThrow(/Redo/);
  expect(() => resolve(menus("mod+shift+h"), "/x", "notes")).not.toThrow();
});

test("two menu items with one key is an error", () => {
  const c = {
    menus: {
      View: [{ title: "A", command: "a", key: "mod+k" }],
      Go: [{ title: "B", command: "b", key: "mod+K" }],
    },
  };
  expect(() => resolve(c, "/x", "notes")).toThrow(/"B" and "A" both use/);
});

test("glass is off by default and reaches the shell when on", async () => {
  const { configSwift } = await import("../src/gen/config.ts");
  const off = await loadConfig(app({ "package.json": `{"name":"a"}` }));
  expect(off.glass).toBe(false);
  expect(configSwift(off)).toContain("static let glass = false");
  const on = await loadConfig(
    app({ "package.json": `{"name":"a","steambun":{"glass":true}}` }),
  );
  expect(configSwift(on)).toContain("static let glass = true");
});

test("toolbar items reach the shell, and keep the title bar", async () => {
  const { configSwift } = await import("../src/gen/config.ts");
  const c = await loadConfig(
    app({
      "package.json": JSON.stringify({
        name: "a",
        steambun: {
          window: { titlebar: "hidden" },
          toolbar: [{ title: "Play", command: "play", symbol: "play" }, "-"],
        },
      }),
    }),
  );
  const s = configSwift(c);
  expect(s).toContain(
    `static let toolbar: [ToolbarItemSpec] = [.button("Play", "play", "play"), .space]`,
  );
  expect(s).toContain("static let hiddenTitlebar = false");
});

test("a menu bar app has no toolbar", async () => {
  const c = await loadConfig(
    app({
      "package.json": JSON.stringify({
        name: "a",
        steambun: {
          menuBar: { icon: "checklist" },
          toolbar: [{ title: "Play", command: "play", symbol: "play" }],
        },
      }),
    }),
  );
  expect(c.toolbar).toEqual([]);
});

test("inline: bakes the listed vars into the core, and only those", () => {
  const d = app({
    "package.json": JSON.stringify({
      name: "envy",
      steambun: { core: "core.ts", bun: "system", inline: ["ENVY_ID"] },
    }),
    "index.html": "<p>hi</p>",
    "core.ts": "console.log(process.env.ENVY_ID, process.env.ENVY_TOKEN);",
    // Bun loads .env on its own; a var that shares the name's prefix must
    // not ship.
    ".env": "ENVY_TOKEN=ghp_personal",
  });
  // Bun.build reads the env from when its process started, so build in a
  // child, as `steambun build` runs from a shell.
  const r = Bun.spawnSync({
    cmd: [
      process.execPath,
      join(import.meta.dir, "../src/cli.ts"),
      "build",
      "--json",
    ],
    cwd: d,
    env: { ...process.env, ENVY_ID: "abc123" },
  });
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.steps[0].note).toContain("inlined ENVY_ID");
  expect(out.steps[0].note).not.toContain("abc123");
  const js = readFileSync(join(d, "build/core/core.js"), "utf8");
  expect(js).toContain('"abc123"');
  expect(js).not.toContain("ghp_personal");
  expect(js).toContain("process.env.ENVY_TOKEN");
});

test("inline: a pattern is refused", () => {
  expect(() => resolve({ name: "x", inline: ["ENVY_*"] }, "/tmp")).toThrow(
    "exact name",
  );
});
