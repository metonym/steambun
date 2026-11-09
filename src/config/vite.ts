import { asRecord } from "../util/guards";
import { log } from "../util/terminal";
import type {
  BuildOptions,
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
  "allowedHosts",
]);
const BUILD_KEYS = new Set([
  "outDir",
  "assetsDir",
  "sourcemap",
  "minify",
  "manifest",
  "target",
]);
const BUN_TARGETS = new Set(["browser", "bun", "node"]);
// `extensions` is accepted and dropped: Bun already resolves .ts/.tsx/.js/.jsx/.json.
const RESOLVE_KEYS = new Set(["alias", "extensions"]);
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

/** Only `{ key, cert }` file paths map; Vite's `true` and inline PEM/Buffer values don't. */
function viteHttps(https: unknown): boolean {
  const rec = asRecord(https);
  return typeof rec?.key === "string" && typeof rec.cert === "string";
}

/** Copies `allowed` keys, warning on the rest. `undefined` for a non-object or when nothing was allowed. */
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

/** Converts the static, data-only subset of a Vite config, listing every key that was ignored. */
export function convertViteConfig(vite: Record<string, unknown>): {
  config: UserConfig;
  ignored: string[];
} {
  const config: UserConfig = {};
  const ignored: string[] = [];
  const unsupported = (path: string) => void ignored.push(path);

  for (const key of Object.keys(vite)) {
    if (!TOP_KEYS.has(key)) unsupported(key);
  }

  const server = pick("server", vite.server, SERVER_KEYS, unsupported);
  if (server) {
    if ("https" in server && !viteHttps(server.https)) {
      delete server.https;
      unsupported("server.https");
    }
    // Vite's legacy spelling of `true`.
    if (server.allowedHosts === "all") server.allowedHosts = true;
    if (Object.keys(server).length > 0) config.server = server as ServerOptions;
  }

  const build = pick("build", vite.build, BUILD_KEYS, unsupported);
  if (build) {
    // Vite's "esbuild" / "terser" / "oxc" minifiers all become Bun's.
    if (typeof build.minify === "string") build.minify = true;
    // Vite's build.target ("esnext", "modules", ...) is a browserslist-style value, not a Bun target.
    if ("target" in build && !BUN_TARGETS.has(build.target as string)) {
      delete build.target;
      unsupported("build.target");
    }
    config.build = build as BuildOptions;
  }

  const viteResolve = pick("resolve", vite.resolve, RESOLVE_KEYS, unsupported);
  if (viteResolve) {
    const resolve: ResolveOptions = {};
    const alias = convertViteAlias(viteResolve.alias);
    if (alias) resolve.alias = alias;
    if (Object.keys(resolve).length > 0) config.resolve = resolve;
  }

  const define = asRecord(vite.define);
  if (define) {
    config.define = Object.fromEntries(
      Object.entries(define).map(([key, value]) => [
        key,
        typeof value === "string" ? value : JSON.stringify(value),
      ]),
    );
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
    unsupported("appType");
  }
  if (vite.plugins !== undefined) ignored.push("plugins");

  return { config, ignored };
}

export function viteConfigToUserConfig(
  vite: Record<string, unknown>,
  warn: (msg: string) => void = log.warn,
): UserConfig {
  const { config, ignored } = convertViteConfig(vite);
  for (const path of ignored) {
    warn(
      path === "plugins"
        ? "[steambun] Vite plugins are ignored; use Bun plugins."
        : `[steambun] Vite config key "${path}" is not supported and was ignored.`,
    );
  }
  return config;
}
