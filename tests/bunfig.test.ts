import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bunfigToUserConfig,
  parseBunfigToml,
  relocateBunfigPaths,
  serializeMergedBunfig,
  stringifyToml,
} from "../src/config/bunfig";
import { findConfigFile, loadConfig } from "../src/config/loader";

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "steambun-bunfig-"));
}

describe("bunfigToUserConfig", () => {
  test("maps native bunfig keys and the [steambun] table", () => {
    const raw = parseBunfigToml(`
[serve]
port = 3000

[define]
"process.env.bagel" = "'lox'"

[serve.static]
env = "PUBLIC_*"

[steambun]
api = "./src/api"
publicDir = "static"
compile = true
appType = "mpa"

[steambun.server]
host = true
open = "/admin"

[steambun.server.proxy]
"/api-legacy" = "http://localhost:8080"

[steambun.server.proxy."/ws"]
target = "http://localhost:9000"
ws = true

[steambun.build]
outDir = "build"
target = "browser"
splitting = true

[steambun.resolve.alias]
"@" = "./src"
`);
    const config = bunfigToUserConfig(raw);
    expect(config.server?.port).toBe(3000);
    expect(config.define?.["process.env.bagel"]).toBe("'lox'");
    expect(config.envPrefix).toEqual(["PUBLIC_"]);
    expect(config.api).toBe("./src/api");
    expect(config.publicDir).toBe("static");
    expect(config.compile).toBe(true);
    expect(config.appType).toBe("mpa");
    expect(config.server?.host).toBe(true);
    expect(config.server?.open).toBe("/admin");
    expect(config.server?.proxy).toEqual({
      "/api-legacy": "http://localhost:8080",
      "/ws": { target: "http://localhost:9000", ws: true },
    });
    expect(config.build?.outDir).toBe("build");
    expect(config.build?.target).toBe("browser");
    expect(config.build?.splitting).toBe(true);
    expect(config.resolve?.alias).toEqual({ "@": "./src" });
  });

  test("[steambun] envPrefix and server.port win over native bunfig keys", () => {
    const config = bunfigToUserConfig(
      parseBunfigToml(`
[serve]
port = 3000
[serve.static]
env = "PUBLIC_*"
[steambun]
envPrefix = ["VITE_", "PUBLIC_"]
[steambun.server]
port = 5173
`),
    );
    expect(config.server?.port).toBe(5173);
    expect(config.envPrefix).toEqual(["VITE_", "PUBLIC_"]);
  });

  test("ignores inline and disable serve.static env values", () => {
    expect(
      bunfigToUserConfig(parseBunfigToml(`[serve.static]\nenv = "inline"\n`))
        .envPrefix,
    ).toBeUndefined();
  });

  test("[steambun.compile] table maps to a CompileOptions object", () => {
    const config = bunfigToUserConfig(
      parseBunfigToml(`
[steambun.compile]
targets = ["bun-linux-x64", "bun-darwin-arm64"]
outDir = "out"
autoloadDotenv = true
autoloadBunfig = false
bytecode = true

[steambun.compile.windows]
title = "My App"
hideConsole = true
`),
    );
    expect(config.compile).toEqual({
      targets: ["bun-linux-x64", "bun-darwin-arm64"],
      outDir: "out",
      autoloadDotenv: true,
      autoloadBunfig: false,
      bytecode: true,
      windows: { title: "My App", hideConsole: true },
    });
  });

  test("decodes every [steambun.build] key", () => {
    const config = bunfigToUserConfig(
      parseBunfigToml(`
[steambun.build]
outDir = "dist"
assetsDir = "static"
sourcemap = "inline"
minify = { whitespace = true, syntax = true }
drop = ["debugger", "console"]
standalone = true
manifest = true
target = "node"
splitting = true
precompress = ["gzip", "br"]
server = false
features = ["a", "b"]

[steambun.build.budgets]
"assets/*.js" = "250kb"
`),
    );
    expect(config.build).toEqual({
      outDir: "dist",
      assetsDir: "static",
      sourcemap: "inline",
      minify: { whitespace: true, syntax: true },
      drop: ["debugger", "console"],
      standalone: true,
      manifest: true,
      target: "node",
      splitting: true,
      precompress: ["gzip", "br"],
      server: false,
      features: ["a", "b"],
      budgets: { "assets/*.js": "250kb" },
    });
  });

  test("[steambun.server] strictPort decodes", () => {
    const config = bunfigToUserConfig(
      parseBunfigToml(`[steambun.server]\nstrictPort = true\n`),
    );
    expect(config.server?.strictPort).toBe(true);
  });
});

describe("bunfigToUserConfig warnings", () => {
  function capture(toml: string): {
    config: ReturnType<typeof bunfigToUserConfig>;
    warnings: string[];
  } {
    const warnings: string[] = [];
    const config = bunfigToUserConfig(parseBunfigToml(toml), (message) =>
      warnings.push(message),
    );
    return { config, warnings };
  }

  test("warns on an unknown top-level [steambun] key", () => {
    const { warnings } = capture(`[steambun]\nprot = 3000\n`);
    expect(warnings).toEqual([
      '[steambun] Unknown bunfig key "steambun.prot" was ignored.',
    ]);
  });

  test("keys that exist on Object.prototype are unknown keys, not decoders", () => {
    const { config, warnings } = capture(
      `[steambun]\nconstructor = 1\ntoString = "x"\n[steambun.server]\nhasOwnProperty = true\n`,
    );
    expect(warnings).toEqual([
      '[steambun] Unknown bunfig key "steambun.constructor" was ignored.',
      '[steambun] Unknown bunfig key "steambun.toString" was ignored.',
      '[steambun] Unknown bunfig key "steambun.server.hasOwnProperty" was ignored.',
    ]);
    expect(Object.keys(config)).toEqual(["server"]);
  });

  test("warns on an unknown nested key", () => {
    const { warnings } = capture(`[steambun.build]\noutdir = "out"\n`);
    expect(warnings).toEqual([
      '[steambun] Unknown bunfig key "steambun.build.outdir" was ignored.',
    ]);
  });

  test("warns on a wrong-typed server.port", () => {
    const { config, warnings } = capture(`[steambun.server]\nport = "5173"\n`);
    expect(config.server?.port).toBeUndefined();
    expect(warnings).toEqual([
      '[steambun] bunfig key "steambun.server.port" expected number, got string — ignored.',
    ]);
  });

  test("drops an unknown precompress encoding but keeps the valid ones", () => {
    const { config, warnings } = capture(
      `[steambun.build]\nprecompress = ["gzip", "xz"]\n`,
    );
    expect(config.build?.precompress).toEqual(["gzip"]);
    expect(warnings).toEqual([
      '[steambun] bunfig key "steambun.build.precompress[1]" has an unknown precompress encoding "xz" — ignored.',
    ]);
  });

  test("[define] drops only the non-string entry", () => {
    const { config, warnings } = capture(`
[define]
a = "1"
b = 2
c = "3"
`);
    expect(config.define).toEqual({ a: "1", c: "3" });
    expect(warnings).toEqual([
      '[steambun] bunfig key "define.b" expected string, got number — ignored.',
    ]);
  });

  test("no warnings for a fully valid config, including native [serve]/[define]", () => {
    const { warnings } = capture(`
[serve]
port = 3000

[define]
FOO = "bar"

[serve.static]
env = "PUBLIC_*"

[steambun]
api = "./src/api"

[steambun.server]
host = true

[steambun.build]
outDir = "dist"
manifest = true
precompress = ["gzip", "br"]

[steambun.resolve.alias]
"@" = "./src"
`);
    expect(warnings).toEqual([]);
  });
});

describe("serializeMergedBunfig", () => {
  test("keeps user tables and appends generated plugins", () => {
    const user = parseBunfigToml(`
preload = ["./preload.ts"]
[define]
"process.env.bagel" = "'lox'"
[serve.static]
plugins = ["bun-plugin-tailwind"]
[install]
exact = true
[steambun]
api = "./src/api"
`);
    const source = serializeMergedBunfig(user, ["./env-plugin.ts"]);
    expect(source).toContain('preload = ["./preload.ts"]');
    expect(source).toContain('"process.env.bagel" = "\'lox\'"');
    expect(source).toContain("bun-plugin-tailwind");
    expect(source).toContain("./env-plugin.ts");
    expect(source).toContain("exact = true");
    expect(source).not.toContain("[steambun]");
    expect(source).not.toContain("./src/api");
  });

  test("round-trips define keys with dots", () => {
    const raw = { define: { "process.env.bagel": "'lox'" } };
    const text = stringifyToml(raw);
    expect(parseBunfigToml(text).define).toEqual(raw.define);
  });
});

describe("relocateBunfigPaths", () => {
  test("rewrites relative plugins and preload to the generated bunfig dir", () => {
    const relocated = relocateBunfigPaths(
      {
        preload: ["./preload.ts"],
        serve: {
          static: { plugins: ["./plugins/x.ts", "bun-plugin-tailwind"] },
        },
      },
      "/project",
      "/project/.steambun",
    );
    expect(relocated.preload).toEqual(["../preload.ts"]);
    const serve = relocated.serve;
    expect(serve && typeof serve === "object" && "static" in serve).toBe(true);
    const staticTable =
      serve && typeof serve === "object"
        ? (serve as { static?: { plugins?: string[] } }).static
        : undefined;
    expect(staticTable?.plugins).toEqual([
      "../plugins/x.ts",
      "bun-plugin-tailwind",
    ]);
  });
});

describe("findConfigFile / loadConfig", () => {
  test("discovers bunfig.toml when no steambun.config exists", async () => {
    const root = tmpProject();
    writeFileSync(
      join(root, "bunfig.toml"),
      `[steambun]\napi = "./src/api"\n[serve]\nport = 4000\n`,
    );
    const found = findConfigFile(root);
    expect(found?.kind).toBe("bunfig");
    const config = await loadConfig({
      root,
      command: "dev",
      mode: "development",
    });
    expect(config.configFile).toBe(join(root, "bunfig.toml"));
    expect(config.server.port).toBe(4000);
    expect(config.api).toBe(join(root, "src/api"));
  });

  test("prefers steambun.config.ts over bunfig.toml", async () => {
    const root = tmpProject();
    writeFileSync(
      join(root, "steambun.config.ts"),
      `export default { server: { port: 5173 } };\n`,
    );
    writeFileSync(join(root, "bunfig.toml"), `[serve]\nport = 3000\n`);
    expect(findConfigFile(root)?.kind).toBe("steambun");
    const config = await loadConfig({
      root,
      command: "dev",
      mode: "development",
    });
    expect(config.server.port).toBe(5173);
  });

  test("an explicit undefined server/build value falls back to the default", async () => {
    const root = tmpProject();
    writeFileSync(
      join(root, "steambun.config.ts"),
      `export default { server: { port: undefined, open: true }, build: { outDir: undefined } };\n`,
    );
    const config = await loadConfig({
      root,
      command: "dev",
      mode: "development",
    });
    expect(config.server.port).toBe(5173);
    expect(config.server.open).toBe(true);
    expect(config.build.outDir).toBe("dist");
  });

  test("a function-form vite config sees Vite's command names", async () => {
    const root = tmpProject();
    writeFileSync(
      join(root, "vite.config.ts"),
      `export default ({ command }) => ({ server: { port: command === "serve" ? 4000 : 5000 } });\n`,
    );
    const dev = await loadConfig({ root, command: "dev", mode: "development" });
    const build = await loadConfig({
      root,
      command: "build",
      mode: "production",
    });
    expect(dev.server.port).toBe(4000);
    expect(build.server.port).toBe(5000);
  });

  test("resolves bare middleware specifiers from the project, not from steambun", async () => {
    const root = tmpProject();
    mkdirSync(join(root, "node_modules/mw-pkg"), { recursive: true });
    writeFileSync(
      join(root, "node_modules/mw-pkg/package.json"),
      `{ "name": "mw-pkg", "main": "index.js" }`,
    );
    writeFileSync(
      join(root, "node_modules/mw-pkg/index.js"),
      `export default (req, next) => next();\n`,
    );
    writeFileSync(
      join(root, "bunfig.toml"),
      `[steambun]\nmiddleware = ["mw-pkg"]\n`,
    );
    const config = await loadConfig({
      root,
      command: "dev",
      mode: "development",
    });
    expect(config.middleware).toHaveLength(1);
  });

  test("a middleware specifier without a function default export warns", async () => {
    const root = tmpProject();
    writeFileSync(join(root, "mw.ts"), `export default 42;\n`);
    writeFileSync(
      join(root, "bunfig.toml"),
      `[steambun]\nmiddleware = ["./mw.ts"]\n`,
    );
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config = await loadConfig({
        root,
        command: "dev",
        mode: "development",
      });
      expect(config.middleware).toEqual([]);
      expect(warn.mock.calls[0]?.[0]).toContain('middleware "./mw.ts"');
    } finally {
      warn.mockRestore();
    }
  });

  test("an unresolvable specifier names it in the error", async () => {
    const root = tmpProject();
    writeFileSync(
      join(root, "bunfig.toml"),
      `[steambun]\nmiddleware = ["./missing.ts"]\n`,
    );
    await expect(
      loadConfig({ root, command: "dev", mode: "development" }),
    ).rejects.toThrow('bunfig middleware "./missing.ts"');
  });

  test("resolves [steambun] middleware specifiers", async () => {
    const root = tmpProject();
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "src/mw.ts"),
      `export default async function auth(req, next) { return next(); }\n`,
    );
    writeFileSync(
      join(root, "bunfig.toml"),
      `[steambun]\nmiddleware = ["./src/mw.ts"]\n`,
    );
    const config = await loadConfig({
      root,
      command: "dev",
      mode: "development",
    });
    expect(config.middleware).toHaveLength(1);
    expect(typeof config.middleware?.[0]).toBe("function");
  });
});
