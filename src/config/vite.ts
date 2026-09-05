import type { BuildOptions, ServerOptions, UserConfig } from "./types";

const SERVER_KEYS = new Set([
  "port",
  "host",
  "open",
  "cors",
  "headers",
  "proxy",
  "https",
]);
const BUILD_KEYS = new Set([
  "outDir",
  "assetsDir",
  "sourcemap",
  "minify",
  "manifest",
  "target",
]);
const TOP_KEYS = new Set([
  "server",
  "build",
  "resolve",
  "define",
  "envPrefix",
  "envDir",
  "base",
  "publicDir",
  "appType",
  "plugins",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function convertViteAlias(alias: unknown): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  if (Array.isArray(alias)) {
    for (const entry of alias) {
      if (
        isRecord(entry) &&
        typeof entry.find === "string" &&
        typeof entry.replacement === "string"
      ) {
        out[entry.find] = entry.replacement;
      }
    }
  } else if (isRecord(alias)) {
    for (const [key, value] of Object.entries(alias)) {
      if (typeof value === "string") out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Converts the static, data-only subset of a Vite config into a steambun
 * `UserConfig`, warning (once per key) for anything not on the allowlist:
 * `server.{port,host,open,cors,headers,proxy,https}`,
 * `build.{outDir,assetsDir,sourcemap,minify,manifest,target}`,
 * `resolve.alias` (array or object form), `define`, `envPrefix`, `envDir`,
 * `base`, `publicDir`, `appType` (`"spa"`/`"mpa"` only), and `plugins`
 * (always warned — Vite plugins can't run under Bun's bundler).
 */
export function viteConfigToUserConfig(
  vite: Record<string, unknown>,
  warn: (msg: string) => void = console.warn,
): UserConfig {
  const config: UserConfig = {};
  const unsupported = (path: string) =>
    warn(
      `[steambun] Vite config key "${path}" is not supported and was ignored.`,
    );

  for (const key of Object.keys(vite)) {
    if (!TOP_KEYS.has(key)) unsupported(key);
  }

  if (isRecord(vite.server)) {
    const server: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(vite.server)) {
      if (SERVER_KEYS.has(key)) server[key] = value;
      else unsupported(`server.${key}`);
    }
    if (Object.keys(server).length > 0) {
      config.server = server as ServerOptions;
    }
  }

  if (isRecord(vite.build)) {
    const build: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(vite.build)) {
      if (BUILD_KEYS.has(key)) build[key] = value;
      else unsupported(`build.${key}`);
    }
    if (Object.keys(build).length > 0) {
      config.build = build as BuildOptions;
    }
  }

  if (isRecord(vite.resolve)) {
    for (const key of Object.keys(vite.resolve)) {
      if (key !== "alias") unsupported(`resolve.${key}`);
    }
    const alias = convertViteAlias(vite.resolve.alias);
    if (alias) config.resolve = { alias };
  }

  if (isRecord(vite.define)) {
    config.define = vite.define as Record<string, string>;
  }
  if (typeof vite.envPrefix === "string" || Array.isArray(vite.envPrefix)) {
    config.envPrefix = vite.envPrefix as string | string[];
  }
  if (typeof vite.envDir === "string") config.envDir = vite.envDir;
  if (typeof vite.base === "string") config.base = vite.base;
  if (vite.publicDir === false || typeof vite.publicDir === "string") {
    config.publicDir = vite.publicDir;
  }
  if (vite.appType === "spa" || vite.appType === "mpa") {
    config.appType = vite.appType;
  } else if (vite.appType !== undefined) {
    unsupported(`appType: ${JSON.stringify(vite.appType)}`);
  }
  if (vite.plugins !== undefined) {
    warn("[steambun] Vite plugins are ignored; use Bun plugins.");
  }

  return config;
}
