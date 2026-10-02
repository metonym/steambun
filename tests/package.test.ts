import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";
import * as publicApi from "../src/index";
import * as internalApi from "../src/internal";
import * as runtimeApi from "../src/runtime/index";

const root = join(import.meta.dir, "..");

test("public entry points export exactly the documented runtime values", () => {
  expect(Object.keys(publicApi).sort()).toEqual([
    "EnvValidationError",
    "build",
    "defineConfig",
    "dev",
    "loadConfig",
    "preview",
  ]);
  expect(Object.keys(runtimeApi).sort()).toEqual(["createApp", "route"]);
});

test("steambun/internal exports every factory generated code imports", () => {
  expect(Object.keys(internalApi).sort()).toEqual([
    "bunfigToUserConfig",
    "createAliasPlugin",
    "createApp",
    "createDevTransformPlugin",
    "createServerBoundaryPlugin",
    "createViteSuffixPlugin",
    "displayServerUrls",
    "hostnameFromHost",
    "loadConfig",
    "openBrowser",
    "resolveBunfigModules",
    "resolveDefaults",
    "resolveOpenUrl",
    "serveWithPortRetry",
    "tlsFromHttps",
    "toConfigEnv",
    "validateEnv",
    "viteConfigToUserConfig",
  ]);
});

test("package.json bin, exports, and files resolve inside the published src/", () => {
  const targets = [
    ...Object.values(pkg.bin),
    pkg.exports["."],
    pkg.exports["./runtime"],
    pkg.exports["./internal"],
    pkg.exports["./client"].types,
    pkg.exports["./client"].default,
  ];
  for (const target of targets) {
    expect(target.startsWith("./src/") || target.startsWith("src/")).toBe(true);
    expect(existsSync(join(root, target))).toBe(true);
  }
  expect(pkg.files).toEqual(["src"]);
});

test("engines.bun matches the minimum Bun version the README states", async () => {
  const readme = await Bun.file(join(root, "README.md")).text();
  expect(readme).toContain(
    `Requires Bun ${pkg.engines.bun.replace(">=", ">= ")}`,
  );
});
