import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAliasPlugin, matchAlias, VITE_SUFFIX } from "../src/util/alias";
import { createViteSuffixPlugin } from "../src/util/vite-suffix-plugin";

test("matchAlias prefers the longest key and treats a trailing-slash key as a prefix", () => {
  const entries = [
    ["@/lib", "/app/lib"],
    ["@", "/app/src"],
    ["~/", "/app/home"],
  ] as const;
  expect(matchAlias("@/lib/x", entries)).toEqual({
    to: "/app/lib",
    rest: "x",
  });
  expect(matchAlias("@/y", entries)).toEqual({ to: "/app/src", rest: "y" });
  expect(matchAlias("@", entries)).toEqual({ to: "/app/src", rest: "" });
  expect(matchAlias("@scope/pkg", entries)).toBeUndefined();
  expect(matchAlias("~/z", entries)).toEqual({ to: "/app/home", rest: "z" });
});

test("an aliased ?raw import resolves through the alias", async () => {
  const root = mkdtempSync(join(tmpdir(), "steambun-alias-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/data.txt"), "hello");
  writeFileSync(join(root, "src/util.ts"), "export const n = 1;");
  writeFileSync(
    join(root, "src/main.ts"),
    'import raw from "@/data.txt?raw";\nimport { n } from "@/util";\nconsole.log(raw, n);\n',
  );
  const alias = { "@": "./src" };
  const result = await Bun.build({
    entrypoints: [join(root, "src/main.ts")],
    throw: false,
    plugins: [
      createAliasPlugin(alias, root),
      createViteSuffixPlugin(alias, root),
    ],
  });
  expect(result.logs.map(String)).toEqual([]);
  expect(await result.outputs[0]?.text()).toContain('"hello"');
});

test("VITE_SUFFIX matches raw/url/inline anywhere in the query, as whole params", () => {
  for (const spec of [
    "./a.txt?raw",
    "./a.txt?raw&x=1",
    "./a.txt?x=1&url",
    "./a.txt?a&inline&b",
  ]) {
    expect(VITE_SUFFIX.test(spec)).toBe(true);
  }
  for (const spec of [
    "./a.txt",
    "./a.txt?rawx",
    "./a.txt?x=raw",
    "./a.txt?w=1",
  ]) {
    expect(VITE_SUFFIX.test(spec)).toBe(false);
  }
});

test("combined query forms follow Vite: raw beats inline beats url, other params are ignored", async () => {
  const root = mkdtempSync(join(tmpdir(), "steambun-suffix-"));
  writeFileSync(join(root, "data.txt"), "hello");
  writeFileSync(
    join(root, "main.ts"),
    [
      'import a from "./data.txt?raw&x=1";',
      'import b from "./data.txt?x=1&raw";',
      'import c from "./data.txt?url&inline";',
      'import d from "./data.txt?inline&url";',
      'import e from "./data.txt?raw&inline";',
      'import f from "./data.txt?url";',
      'import g from "./data.txt?inline";',
      "export { a, b, c, d, e, f, g };",
    ].join("\n"),
  );
  const result = await Bun.build({
    entrypoints: [join(root, "main.ts")],
    outdir: join(root, "dist"),
    target: "bun",
    plugins: [createViteSuffixPlugin(undefined, root)],
  });
  expect(result.success).toBe(true);
  const mod = (await import(result.outputs[0]!.path)) as Record<string, string>;
  const dataUrl = `data:text/plain;base64,${btoa("hello")}`;
  expect(mod.a).toBe("hello");
  expect(mod.b).toBe("hello");
  expect(mod.c?.startsWith("data:")).toBe(true);
  expect(atob(mod.c!.split("base64,")[1]!)).toBe("hello");
  expect(mod.d).toBe(mod.c);
  expect(mod.c).toContain(dataUrl.slice(dataUrl.indexOf(";")));
  expect(mod.e).toBe("hello");
  expect(mod.f).toContain("data");
  expect(mod.f?.startsWith("data:")).toBe(false);
  expect(mod.g).toBe(mod.c);
});

test("an unresolvable suffixed import fails with a [steambun] cannot resolve error", async () => {
  const root = mkdtempSync(join(tmpdir(), "steambun-suffix-"));
  writeFileSync(
    join(root, "main.ts"),
    'import raw from "./missing.txt?raw";\nconsole.log(raw);\n',
  );
  const result = await Bun.build({
    entrypoints: [join(root, "main.ts")],
    throw: false,
    plugins: [createViteSuffixPlugin(undefined, root)],
  });
  expect(result.success).toBe(false);
  const message = result.logs.map(String).join("\n");
  expect(message).toContain('[steambun] cannot resolve "./missing.txt?raw"');
  expect(message).toContain(root);
});
