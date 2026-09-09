import { asRecord } from "../util/guards";
import type {
  BuildOptions,
  PreviewOptions,
  ResolveOptions,
  ServerOptions,
  UserConfig,
} from "./types";

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
const PREVIEW_KEYS = new Set(["port", "host", "open", "strictPort"]);
const TOP_KEYS = new Set([
  "server",
  "build",
  "preview",
  "resolve",
  "define",
  "envPrefix",
  "envDir",
  "base",
  "publicDir",
  "appType",
  "plugins",
]);

function convertViteAlias(alias: unknown): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  if (Array.isArray(alias)) {
    for (const entry of alias) {
      const rec = asRecord(entry);
      if (
        rec &&
        typeof rec.find === "string" &&
        typeof rec.replacement === "string"
      ) {
        out[rec.find] = rec.replacement;
      }
    }
  } else {
    const rec = asRecord(alias);
    for (const [key, value] of Object.entries(rec ?? {})) {
      if (typeof value === "string") out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Copies `allowed` keys of `raw` into a fresh object, warning (via
 * `unsupported`) on everything else — the shared "allowlist, warn the rest"
 * shape behind `server`/`build`/`preview`. Returns `undefined` for a
 * non-object `raw` or an object with no allowed keys, so callers can
 * `if (picked) config.x = picked`. */
function pick(
  section: string,
  raw: unknown,
  allowed: Set<string>,
  unsupported: (path: string) => void,
): Record<string, unknown> | undefined {
  const rec = asRecord(raw);
  if (!rec) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rec)) {
    if (allowed.has(key)) out[key] = value;
    else unsupported(`${section}.${key}`);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Converts the static, data-only subset of a Vite config into a steambun
 * `UserConfig`, warning (once per key) for anything not on the allowlist:
 * `server.{port,host,open,cors,headers,proxy,https}`,
 * `build.{outDir,assetsDir,sourcemap,minify,manifest,target}`,
 * `preview.{port,host,open,strictPort}`,
 * `resolve.{alias,extensions}` (alias as array or object form), `define`,
 * `envPrefix`, `envDir`, `base`, `publicDir`, `appType` (`"spa"`/`"mpa"`
 * only), and `plugins` (always warned — Vite plugins can't run under Bun's
 * bundler).
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

  const server = pick("server", vite.server, SERVER_KEYS, unsupported);
  if (server) config.server = server as ServerOptions;

  const build = pick("build", vite.build, BUILD_KEYS, unsupported);
  if (build) config.build = build as BuildOptions;

  const preview = pick("preview", vite.preview, PREVIEW_KEYS, unsupported);
  if (preview) config.preview = preview as PreviewOptions;

  const viteResolve = asRecord(vite.resolve);
  if (viteResolve) {
    const resolve: Record<string, unknown> = {};
    for (const key of Object.keys(viteResolve)) {
      if (key !== "alias" && key !== "extensions")
        unsupported(`resolve.${key}`);
    }
    const alias = convertViteAlias(viteResolve.alias);
    if (alias) resolve.alias = alias;
    if (
      Array.isArray(viteResolve.extensions) &&
      viteResolve.extensions.every((ext) => typeof ext === "string")
    ) {
      resolve.extensions = viteResolve.extensions;
    }
    if (Object.keys(resolve).length > 0) {
      config.resolve = resolve as ResolveOptions;
    }
  }

  const define = asRecord(vite.define);
  if (define) config.define = define as Record<string, string>;
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
