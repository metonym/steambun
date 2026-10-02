import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bunfigToUserConfig,
  loadBunfigPlugins,
  parseBunfigToml,
} from "../src/config/bunfig";
import {
  configKindOf,
  findConfigFile,
  findConfigFiles,
  loadConfig,
  resolveDefaults,
  toConfigEnv,
} from "../src/config/loader";
import { viteConfigToUserConfig } from "../src/config/vite";
import { synthesizeDevServer } from "../src/dev/synth";

function tmpProject(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "steambun-config-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

const load = (root: string, extra: { configFile?: string } = {}) =>
  loadConfig({ root, command: "dev", mode: "development", ...extra });

const ctx = (root = "/proj") => ({
  root,
  command: "dev" as const,
  mode: "development",
  configFile: null,
});

describe("config discovery order", () => {
  test("steambun.config.* > bunfig.toml > vite.config.*", () => {
    const root = tmpProject({
      "vite.config.ts": "export default {};\n",
      "bunfig.toml": "",
      "steambun.config.ts": "export default {};\n",
    });
    expect(findConfigFiles(root).map((found) => found.kind)).toEqual([
      "steambun",
      "bunfig",
      "vite",
    ]);
    expect(findConfigFile(root)?.kind).toBe("steambun");
  });

  test("bunfig.toml wins over vite.config.*", async () => {
    const root = tmpProject({
      "vite.config.ts": "export default { server: { port: 4000 } };\n",
      "bunfig.toml": "[serve]\nport = 3000\n",
    });
    expect(findConfigFile(root)?.kind).toBe("bunfig");
    expect((await load(root)).server.port).toBe(3000);
  });

  test("vite.config.* is used only when nothing else exists", async () => {
    const root = tmpProject({
      "vite.config.ts": "export default { server: { port: 4000 } };\n",
    });
    expect(findConfigFile(root)?.kind).toBe("vite");
    expect((await load(root)).server.port).toBe(4000);
  });

  test("an explicit --config vite.config.* is converted, not used raw", async () => {
    const root = tmpProject({
      "vite.config.ts":
        "export default { server: { port: 4000, hmr: false }, root: 'x', plugins: [] };\n",
      "steambun.config.ts": "export default { server: { port: 1 } };\n",
    });
    expect(configKindOf(join(root, "vite.config.mts"))).toBe("vite");
    const config = await load(root, { configFile: "vite.config.ts" });
    expect(config.server.port).toBe(4000);
    expect(config.server).not.toHaveProperty("hmr");
    expect(config.plugins).toEqual([]);
  });
});

describe("config function env", () => {
  test("toConfigEnv follows Vite's shape", () => {
    expect(toConfigEnv("dev", "development")).toEqual({
      command: "serve",
      mode: "development",
      isPreview: false,
    });
    expect(toConfigEnv("build", "production")).toEqual({
      command: "build",
      mode: "production",
      isPreview: false,
    });
    expect(toConfigEnv("preview", "production")).toEqual({
      command: "serve",
      mode: "production",
      isPreview: true,
    });
  });

  test("a steambun config function receives the ConfigEnv", async () => {
    const root = tmpProject({
      "steambun.config.ts": `export default (env) => ({ base: JSON.stringify(env) });\n`,
    });
    const config = await loadConfig({
      root,
      command: "preview",
      mode: "staging",
    });
    expect(JSON.parse(config.base)).toEqual({
      command: "serve",
      mode: "staging",
      isPreview: true,
    });
  });

  test("a vite config function receives the same ConfigEnv", async () => {
    const root = tmpProject({
      "vite.config.ts": `export default (env) => ({ base: JSON.stringify(env) });\n`,
    });
    const config = await loadConfig({
      root,
      command: "build",
      mode: "production",
    });
    expect(JSON.parse(config.base)).toEqual({
      command: "build",
      mode: "production",
      isPreview: false,
    });
  });
});

describe("config validation", () => {
  test.each([-1, 65536, 1.5, Number.NaN])("rejects server.port %p", (port) => {
    expect(() => resolveDefaults({ server: { port } }, ctx())).toThrow(
      "[steambun] server.port must be an integer between 0 and 65535",
    );
  });

  test("accepts port 0 and 65535", () => {
    expect(resolveDefaults({ server: { port: 0 } }, ctx()).server.port).toBe(0);
    expect(
      resolveDefaults({ server: { port: 65535 } }, ctx()).server.port,
    ).toBe(65535);
  });

  test("rejects server.https: true and malformed https objects", () => {
    expect(() =>
      resolveDefaults({ server: { https: true } as never }, ctx()),
    ).toThrow(
      "[steambun] server.https: true is not supported; pass { key, cert }",
    );
    expect(() =>
      resolveDefaults({ server: { https: { key: "k.pem" } as never } }, ctx()),
    ).toThrow("[steambun] server.https must be");
    expect(
      resolveDefaults(
        { server: { https: { key: "k.pem", cert: "c.pem" } } },
        ctx(),
      ).server.https,
    ).toEqual({ key: "k.pem", cert: "c.pem" });
  });

  test.each([0, -5, 1.5])("rejects maxRequestBodySize %p", (size) => {
    expect(() =>
      resolveDefaults({ server: { maxRequestBodySize: size } }, ctx()),
    ).toThrow(
      "[steambun] server.maxRequestBodySize must be a positive integer",
    );
  });

  test("rejects an empty envPrefix, alone or in an array", () => {
    expect(() => resolveDefaults({ envPrefix: "" }, ctx())).toThrow(
      "[steambun] envPrefix",
    );
    expect(() => resolveDefaults({ envPrefix: ["APP_", ""] }, ctx())).toThrow(
      "[steambun] envPrefix",
    );
    expect(resolveDefaults({ envPrefix: "APP_" }, ctx()).envPrefix).toEqual([
      "APP_",
    ]);
  });

  test("rejects an unparseable build.budgets size", () => {
    expect(() =>
      resolveDefaults({ build: { budgets: { "*.js": "lots" } } }, ctx()),
    ).toThrow("[steambun] Invalid size budget");
    expect(() =>
      resolveDefaults({ build: { budgets: { "*.js": -1 } } }, ctx()),
    ).toThrow('build.budgets["*.js"]');
    expect(() =>
      resolveDefaults({ build: { budgets: { "*.js": "1.5mb" } } }, ctx()),
    ).not.toThrow();
  });

  test("rejects an appType other than spa or mpa", () => {
    expect(() =>
      resolveDefaults({ appType: "custom" as never }, ctx()),
    ).toThrow('[steambun] appType must be "spa" or "mpa"');
  });

  test("rejects build.outDir at root or inside publicDir, accepts it beside them", () => {
    const outDir = (dir: string, publicDir?: string | false) =>
      resolveDefaults({ build: { outDir: dir }, publicDir }, ctx());
    expect(() => outDir(".")).toThrow("must not be the project root");
    expect(() => outDir("/proj")).toThrow("must not be the project root");
    expect(() => outDir("public")).toThrow("must not be inside publicDir");
    expect(() => outDir("public/dist")).toThrow("must not be inside publicDir");
    expect(() => outDir("dist")).not.toThrow();
    expect(() => outDir("public/dist", false)).not.toThrow();
    expect(() => outDir("/elsewhere/dist")).not.toThrow();
  });

  test("rejects a build.outDir that would delete publicDir or api", () => {
    const outDir = (dir: string, extra: Record<string, string>) =>
      resolveDefaults({ build: { outDir: dir }, ...extra }, ctx());
    expect(() => outDir("dist", { publicDir: "dist/static" })).toThrow(
      "must not contain publicDir",
    );
    expect(() => outDir("src", { api: "src/api" })).toThrow(
      "must not contain api",
    );
    expect(() => outDir("dist", { api: "src/api" })).not.toThrow();
  });

  test("resolved config carries a value for every defaultable key", () => {
    const config = resolveDefaults({}, ctx());
    expect(config.plugins).toEqual([]);
    expect(config.middleware).toEqual([]);
    expect(config.define).toEqual({});
    expect(config.resolve).toEqual({ alias: {} });
    expect(config.build.features).toEqual([]);
    expect(config.compile).toBe(false);
  });

  test("loadConfig names a missing --config file and a config that throws on import", async () => {
    const root = tmpProject({
      "broken.config.ts": 'throw new Error("boom");\n',
    });
    await expect(load(root, { configFile: "nope.config.ts" })).rejects.toThrow(
      `[steambun] Config file not found: ${join(root, "nope.config.ts")}`,
    );
    await expect(
      load(root, { configFile: "broken.config.ts" }),
    ).rejects.toThrow(
      `[steambun] Failed to load config at ${join(root, "broken.config.ts")}: boom`,
    );
  });

  test("loadConfig rejects an unrecognized plugin and runs configResolved once per hook plugin", async () => {
    const bad = tmpProject({
      "steambun.config.ts": "export default { plugins: [{ typo() {} }] };\n",
    });
    await expect(load(bad)).rejects.toThrow(
      "[steambun] Unrecognized plugin at index 0",
    );

    const root = tmpProject({
      "steambun.config.ts": `export default { plugins: [{ configResolved(config) { config.base = "/seen/"; } }] };\n`,
    });
    expect((await load(root)).base).toBe("/seen/");
  });

  test("absolute publicDir, envDir, and api are kept as-is; relative ones resolve against root", () => {
    const absolute = resolveDefaults(
      { publicDir: "/abs/public", envDir: "/abs/env", api: "/abs/api" },
      ctx(),
    );
    expect(absolute.publicDir).toBe("/abs/public");
    expect(absolute.envDir).toBe("/abs/env");
    expect(absolute.api).toBe("/abs/api");

    const relative = resolveDefaults(
      { publicDir: "static", envDir: "env", api: "src/api" },
      ctx(),
    );
    expect(relative.publicDir).toBe(join("/proj", "static"));
    expect(relative.envDir).toBe(join("/proj", "env"));
    expect(relative.api).toBe(join("/proj", "src/api"));
  });
});

describe("[steambun.compile]", () => {
  test("an empty table enables compile like `compile: {}`", () => {
    const config = bunfigToUserConfig(
      parseBunfigToml("[steambun.compile]\n"),
      () => {},
    );
    expect(config.compile).toEqual({});
    expect(resolveDefaults(config, ctx()).compile).toEqual({});
  });

  test("a table whose keys were all rejected stays undefined and warns", () => {
    const warnings: string[] = [];
    const config = bunfigToUserConfig(
      parseBunfigToml("[steambun.compile]\nbogus = 1\n"),
      (msg) => warnings.push(msg),
    );
    expect(config.compile).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("removed no-op keys", () => {
  test("[steambun] root and resolve.extensions are unknown TOML keys", () => {
    const warnings: string[] = [];
    const config = bunfigToUserConfig(
      parseBunfigToml(
        'root = "x"\n[steambun]\nroot = "x"\n[steambun.resolve]\nextensions = [".ts"]\n',
      ),
      (msg) => warnings.push(msg),
    );
    expect(config).not.toHaveProperty("root");
    expect(config.resolve).toEqual({});
    expect(warnings.some((w) => w.includes('"steambun.root"'))).toBe(true);
    expect(
      warnings.some((w) => w.includes('"steambun.resolve.extensions"')),
    ).toBe(true);
  });

  test("a Vite config's root and resolve.extensions are dropped", () => {
    const config = viteConfigToUserConfig(
      { root: "x", resolve: { extensions: [".ts"], alias: { a: "b" } } },
      () => {},
    );
    expect(config).toEqual({ resolve: { alias: { a: "b" } } });
  });
});

describe("bunfig plugins", () => {
  const plugin = (name: string) =>
    `export default { name: ${JSON.stringify(name)}, setup() {} };\n`;
  const files = {
    "bunfig.toml": `[serve.static]\nplugins = ["./native.ts"]\n`,
    "native.ts": plugin("native"),
    "other.toml": `[serve.static]\nplugins = ["./other.ts"]\n`,
    "other.ts": plugin("other"),
  };

  const names = async (root: string, configFile: string | null) =>
    (await loadBunfigPlugins(root, configFile)).map((p) => p.name);

  test("[serve.static] plugins load whichever config format is in use", async () => {
    const root = tmpProject({
      ...files,
      "steambun.config.ts": "export default {};\n",
    });
    expect(await names(root, join(root, "steambun.config.ts"))).toEqual([
      "native",
    ]);
    expect(await names(root, join(root, "bunfig.toml"))).toEqual(["native"]);
  });

  test("--config other.toml is read instead of the project bunfig.toml", async () => {
    const root = tmpProject(files);
    expect(await names(root, join(root, "other.toml"))).toEqual(["other"]);
  });

  test("a module without a Bun plugin default export is ignored with a warning", async () => {
    const root = tmpProject({
      "bunfig.toml": `[serve.static]\nplugins = ["./hooks.ts"]\n`,
      "hooks.ts": "export default { configResolved() {} };\n",
    });
    expect(await names(root, null)).toEqual([]);
  });

  test("[steambun] plugins is not a key: it warns and is ignored", () => {
    const warnings: string[] = [];
    const config = bunfigToUserConfig(
      parseBunfigToml(`[steambun]\nplugins = ["./a.ts"]\n`),
      (msg) => warnings.push(msg),
    );
    expect(config.plugins).toBeUndefined();
    expect(warnings.some((w) => w.includes('"steambun.plugins"'))).toBe(true);
  });

  test("the dev bunfig carries [serve.static] plugins and drops the [steambun] table", async () => {
    const root = tmpProject({
      ...files,
      "bunfig.toml": `${files["bunfig.toml"]}[steambun]\nbase = "/x/"\n`,
      "steambun.config.ts": "export default {};\n",
      "index.html": "<html></html>",
    });
    const config = await load(root);
    const { bunfigPath } = await synthesizeDevServer(config, [], {});
    const merged = readFileSync(bunfigPath, "utf8");
    expect(merged).toContain("native.ts");
    expect(merged).not.toContain("steambun]");
  });
});
