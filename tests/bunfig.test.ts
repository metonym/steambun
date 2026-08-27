import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateProdServeSource } from "../src/build/prod-server";
import {
  bunfigToUserConfig,
  parseBunfigToml,
  relocateBunfigPaths,
  serializeMergedBunfig,
  stringifyToml,
} from "../src/config/bunfig";
import { findConfigFile, loadConfig } from "../src/config/loader";
import { generateBunfigSource } from "../src/dev/synth";

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
    const source = serializeMergedBunfig(user, ["./env-plugin.ts"], "PUBLIC_*");
    expect(source).toContain('preload = ["./preload.ts"]');
    expect(source).toContain('"process.env.bagel" = "\'lox\'"');
    expect(source).toContain("bun-plugin-tailwind");
    expect(source).toContain("./env-plugin.ts");
    expect(source).toContain("exact = true");
    expect(source).toContain('env = "PUBLIC_*"');
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

describe("generateBunfigSource", () => {
  test("still writes plugins and a single env glob with no user bunfig", () => {
    const source = generateBunfigSource(["./env-plugin.ts"], "PUBLIC_*");
    expect(source).toContain('plugins = ["./env-plugin.ts"]');
    expect(source).toContain('env = "PUBLIC_*"');
  });
});

describe("generateProdServeSource", () => {
  test("maps a toml config through bunfigToUserConfig", () => {
    const source = generateProdServeSource(
      {
        root: "/project",
        base: "/",
        publicDir: "/project/public",
        mode: "production",
        command: "preview",
        configFile: "/project/bunfig.toml",
        envPrefix: ["PUBLIC_"],
        appType: "spa",
        server: { port: 4173, host: false, cors: false },
        build: {
          outDir: "dist",
          assetsDir: "assets",
          sourcemap: false,
          minify: true,
          manifest: false,
          standalone: false,
          drop: ["debugger"],
        },
      },
      "/project/dist",
    );
    expect(source).toContain("bunfigToUserConfig");
    expect(source).toContain("resolveBunfigModules");
    expect(source).toContain("bunfig.toml");
    expect(source).toContain('spa: config.appType === "spa"');
  });
});
