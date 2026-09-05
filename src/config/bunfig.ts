import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isBunPlugin, isSteambunHooks } from "../util/plugins";
import { toImportSpecifier } from "../util/specifier";
import type {
  BuildOptions,
  HttpsOptions,
  Plugin,
  PreviewOptions,
  ProxyEntry,
  ResolveOptions,
  ServerOptions,
  UserConfig,
} from "./types";

export const BUNFIG_FILENAME = "bunfig.toml";

export function isTomlConfigPath(path: string): boolean {
  return path.endsWith(".toml");
}

export function projectBunfigPath(root: string): string {
  return join(root, BUNFIG_FILENAME);
}

export async function readBunfigFile(
  path: string,
): Promise<Record<string, unknown> | null> {
  if (!existsSync(path)) return null;
  return parseBunfigToml(await Bun.file(path).text());
}

export function parseBunfigToml(text: string): Record<string, unknown> {
  const parsed: unknown = Bun.TOML.parse(text);
  return asRecord(parsed) ?? {};
}

/**
 * Data-only mapping. Plugin objects and middleware factories cannot live in
 * TOML — see {@link resolveBunfigModules} for those.
 *
 * @example
 * ```ts
 * import { bunfigToUserConfig } from "steambun";
 *
 * const raw = Bun.TOML.parse(await Bun.file("bunfig.toml").text());
 * const config = bunfigToUserConfig(raw); // { server: { port: 3000 }, ... }
 * ```
 */
export function bunfigToUserConfig(raw: unknown): UserConfig {
  const root = asRecord(raw) ?? {};
  const native = nativeBunfigToUserConfig(root);
  const steambun = mapSteambunTable(asRecord(root.steambun) ?? {});
  return mergeUserConfig(native, steambun);
}

export function mergeUserConfig(
  base: UserConfig,
  overlay: UserConfig,
): UserConfig {
  return {
    ...base,
    ...overlay,
    server: { ...base.server, ...overlay.server },
    build: { ...base.build, ...overlay.build },
    preview: { ...base.preview, ...overlay.preview },
    resolve: {
      ...base.resolve,
      ...overlay.resolve,
      alias: { ...base.resolve?.alias, ...overlay.resolve?.alias },
    },
    define: { ...base.define, ...overlay.define },
    plugins: overlay.plugins ?? base.plugins,
    middleware: overlay.middleware ?? base.middleware,
  };
}

/**
 * Loads the middleware modules referenced by `[steambun] middleware = [...]`
 * in a legacy `bunfig.toml` and prepends them to `config.middleware`.
 *
 * @example
 * ```ts
 * const raw = Bun.TOML.parse(await Bun.file("bunfig.toml").text());
 * const config = await resolveBunfigModules(bunfigToUserConfig(raw), raw, process.cwd());
 * ```
 */
export async function resolveBunfigModules(
  config: UserConfig,
  raw: unknown,
  root: string,
): Promise<UserConfig> {
  const specs = bunfigMiddlewareSpecifiers(raw);
  if (specs.length === 0) return config;
  const middleware = [];
  for (const spec of specs) {
    const loaded = await importDefault(root, spec);
    if (typeof loaded === "function") middleware.push(loaded);
  }
  return {
    ...config,
    middleware: [...middleware, ...(config.middleware ?? [])],
  };
}

export async function loadBunfigPlugins(root: string): Promise<Plugin[]> {
  const raw = await readBunfigFile(projectBunfigPath(root));
  if (!raw) return [];
  const plugins: Plugin[] = [];
  for (const spec of bunfigPluginSpecifiers(raw)) {
    const loaded = await importDefault(root, spec);
    if (isBunPlugin(loaded) || isSteambunHooks(loaded)) plugins.push(loaded);
  }
  return plugins;
}

export function bunfigPluginSpecifiers(raw: unknown): string[] {
  const root = asRecord(raw) ?? {};
  const serve = asRecord(root.serve) ?? {};
  const staticTable = asRecord(serve.static) ?? {};
  const steambun = asRecord(root.steambun) ?? {};
  return unique([
    ...(asStringArray(staticTable.plugins) ?? []),
    ...(asStringArray(steambun.plugins) ?? []),
  ]);
}

export function relocateBunfigPaths(
  raw: Record<string, unknown>,
  fromRoot: string,
  toDir: string,
): Record<string, unknown> {
  const out = structuredClone(raw);
  const relocate = (spec: string) => relocateSpecifier(spec, fromRoot, toDir);

  const preload = asStringArray(out.preload);
  if (preload) out.preload = preload.map(relocate);

  const test = asRecord(out.test);
  if (test) {
    const testPreload = asStringArray(test.preload);
    if (testPreload) test.preload = testPreload.map(relocate);
    out.test = test;
  }

  const serve = asRecord(out.serve);
  if (serve) {
    const staticTable = asRecord(serve.static);
    if (staticTable) {
      const plugins = asStringArray(staticTable.plugins);
      if (plugins) staticTable.plugins = plugins.map(relocate);
      serve.static = staticTable;
    }
    out.serve = serve;
  }

  const steambun = asRecord(out.steambun);
  if (steambun) {
    const plugins = asStringArray(steambun.plugins);
    if (plugins) steambun.plugins = plugins.map(relocate);
    out.steambun = steambun;
  }

  return out;
}

export function serializeMergedBunfig(
  userRaw: Record<string, unknown>,
  generatedPlugins: string[],
  envPattern: `${string}*` | undefined,
): string {
  const steambun = asRecord(userRaw.steambun) ?? {};
  const extraPlugins = asStringArray(steambun.plugins) ?? [];
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(userRaw)) {
    if (key === "steambun") continue;
    merged[key] = value;
  }

  const serve = { ...(asRecord(merged.serve) ?? {}) };
  const staticTable = { ...(asRecord(serve.static) ?? {}) };
  staticTable.plugins = unique([
    ...(asStringArray(staticTable.plugins) ?? []),
    ...extraPlugins,
    ...generatedPlugins,
  ]);
  if (envPattern !== undefined) staticTable.env = envPattern;
  serve.static = staticTable;
  merged.serve = serve;
  return stringifyToml(merged);
}

export function stringifyToml(root: Record<string, unknown>): string {
  const lines: string[] = [];
  writeTable(lines, [], root);
  while (lines[0] === "") lines.shift();
  return `${lines.join("\n")}\n`;
}

function bunfigMiddlewareSpecifiers(raw: unknown): string[] {
  const steambun = asRecord(asRecord(raw)?.steambun) ?? {};
  return asStringArray(steambun.middleware) ?? [];
}

function nativeBunfigToUserConfig(root: Record<string, unknown>): UserConfig {
  const config: UserConfig = {};
  const define = asStringRecord(root.define);
  if (define) config.define = define;

  const serve = asRecord(root.serve) ?? {};
  if (typeof serve.port === "number") {
    config.server = { ...config.server, port: serve.port };
  }

  const env = asRecord(serve.static)?.env;
  if (typeof env === "string" && env.endsWith("*") && env.length > 1) {
    config.envPrefix = [env.slice(0, -1)];
  }
  return config;
}

function mapSteambunTable(raw: Record<string, unknown>): UserConfig {
  const config: UserConfig = {};
  if (typeof raw.base === "string") config.base = raw.base;
  if (raw.publicDir === false || typeof raw.publicDir === "string") {
    config.publicDir = raw.publicDir;
  }
  if (raw.appType === "spa" || raw.appType === "mpa") {
    config.appType = raw.appType;
  }
  if (typeof raw.api === "string") config.api = raw.api;
  if (typeof raw.compile === "boolean") config.compile = raw.compile;
  const features = asStringArray(raw.features);
  if (features) config.features = features;
  if (typeof raw.envDir === "string") config.envDir = raw.envDir;
  if (typeof raw.envPrefix === "string") config.envPrefix = raw.envPrefix;
  const prefixes = asStringArray(raw.envPrefix);
  if (prefixes) config.envPrefix = prefixes;

  const define = asStringRecord(raw.define);
  if (define) config.define = define;

  const server = mapServer(asRecord(raw.server));
  if (server) config.server = server;
  const build = mapBuild(asRecord(raw.build));
  if (build) config.build = build;
  const preview = mapPreview(asRecord(raw.preview));
  if (preview) config.preview = preview;
  const resolve = mapResolve(asRecord(raw.resolve));
  if (resolve) config.resolve = resolve;
  return config;
}

function mapServer(
  raw: Record<string, unknown> | undefined,
): ServerOptions | undefined {
  if (!raw) return undefined;
  const server: ServerOptions = {};
  if (typeof raw.port === "number") server.port = raw.port;
  if (typeof raw.host === "boolean" || typeof raw.host === "string") {
    server.host = raw.host;
  }
  if (typeof raw.open === "boolean" || typeof raw.open === "string") {
    server.open = raw.open;
  }
  if (typeof raw.cors === "boolean") server.cors = raw.cors;
  if (typeof raw.idleTimeout === "number") server.idleTimeout = raw.idleTimeout;
  if (typeof raw.maxRequestBodySize === "number") {
    server.maxRequestBodySize = raw.maxRequestBodySize;
  }
  const headers = asStringRecord(raw.headers);
  if (headers) server.headers = headers;
  const proxy = mapProxy(raw.proxy);
  if (proxy) server.proxy = proxy;
  const https = mapHttps(asRecord(raw.https));
  if (https) server.https = https;
  return Object.keys(server).length > 0 ? server : undefined;
}

function mapProxy(raw: unknown): Record<string, ProxyEntry> | undefined {
  const rec = asRecord(raw);
  if (!rec) return undefined;
  const out: Record<string, ProxyEntry> = {};
  for (const [key, value] of Object.entries(rec)) {
    if (typeof value === "string") {
      out[key] = value;
      continue;
    }
    const obj = asRecord(value);
    if (!obj || typeof obj.target !== "string") continue;
    out[key] = {
      target: obj.target,
      ...(typeof obj.changeOrigin === "boolean"
        ? { changeOrigin: obj.changeOrigin }
        : {}),
      ...(typeof obj.ws === "boolean" ? { ws: obj.ws } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function mapHttps(
  raw: Record<string, unknown> | undefined,
): HttpsOptions | undefined {
  if (!raw || typeof raw.key !== "string" || typeof raw.cert !== "string") {
    return undefined;
  }
  const https: HttpsOptions = { key: raw.key, cert: raw.cert };
  if (typeof raw.passphrase === "string") https.passphrase = raw.passphrase;
  if (typeof raw.ca === "string") https.ca = raw.ca;
  const caList = asStringArray(raw.ca);
  if (caList) https.ca = caList;
  return https;
}

function mapBuild(
  raw: Record<string, unknown> | undefined,
): BuildOptions | undefined {
  if (!raw) return undefined;
  const build: BuildOptions = {};
  if (typeof raw.outDir === "string") build.outDir = raw.outDir;
  if (typeof raw.assetsDir === "string") build.assetsDir = raw.assetsDir;
  if (typeof raw.sourcemap === "boolean") build.sourcemap = raw.sourcemap;
  if (raw.sourcemap === "inline" || raw.sourcemap === "external") {
    build.sourcemap = raw.sourcemap;
  }
  if (typeof raw.minify === "boolean") build.minify = raw.minify;
  if (raw.minify === "esbuild" || raw.minify === "terser") {
    build.minify = raw.minify;
  }
  if (typeof raw.manifest === "boolean") build.manifest = raw.manifest;
  if (typeof raw.standalone === "boolean") build.standalone = raw.standalone;
  if (typeof raw.bytecode === "boolean") build.bytecode = raw.bytecode;
  if (typeof raw.splitting === "boolean") build.splitting = raw.splitting;
  if (
    raw.target === "browser" ||
    raw.target === "bun" ||
    raw.target === "node"
  ) {
    build.target = raw.target;
  }
  const drop = asStringArray(raw.drop);
  if (drop) build.drop = drop;
  return Object.keys(build).length > 0 ? build : undefined;
}

function mapPreview(
  raw: Record<string, unknown> | undefined,
): PreviewOptions | undefined {
  if (!raw) return undefined;
  const preview: PreviewOptions = {};
  if (typeof raw.port === "number") preview.port = raw.port;
  if (typeof raw.host === "boolean" || typeof raw.host === "string") {
    preview.host = raw.host;
  }
  if (typeof raw.open === "boolean" || typeof raw.open === "string") {
    preview.open = raw.open;
  }
  return Object.keys(preview).length > 0 ? preview : undefined;
}

function mapResolve(
  raw: Record<string, unknown> | undefined,
): ResolveOptions | undefined {
  if (!raw) return undefined;
  const resolve: ResolveOptions = {};
  const alias = asStringRecord(raw.alias);
  if (alias) resolve.alias = alias;
  const extensions = asStringArray(raw.extensions);
  if (extensions) resolve.extensions = extensions;
  return Object.keys(resolve).length > 0 ? resolve : undefined;
}

function relocateSpecifier(
  spec: string,
  fromRoot: string,
  toDir: string,
): string {
  if (!isAbsolute(spec) && !spec.startsWith(".")) return spec;
  const abs = isAbsolute(spec) ? spec : join(fromRoot, spec);
  return toImportSpecifier(toDir, abs);
}

async function importDefault(root: string, spec: string): Promise<unknown> {
  if (isAbsolute(spec) || spec.startsWith(".")) {
    const abs = isAbsolute(spec) ? spec : join(root, spec);
    return (await import(pathToFileURL(abs).href)).default;
  }
  return (await import(spec)).default;
}

function writeTable(
  lines: string[],
  path: string[],
  obj: Record<string, unknown>,
): void {
  const scalars: Array<[string, unknown]> = [];
  const tables: Array<[string, Record<string, unknown>]> = [];

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (isPlainObject(value)) {
      tables.push([key, value]);
      continue;
    }
    scalars.push([key, value]);
  }

  if (path.length === 0) {
    for (const [key, value] of scalars) {
      lines.push(`${escapeTomlKey(key)} = ${encodeTomlValue(value)}`);
    }
  } else if (scalars.length > 0) {
    lines.push("");
    lines.push(`[${path.map(escapeTomlKey).join(".")}]`);
    for (const [key, value] of scalars) {
      lines.push(`${escapeTomlKey(key)} = ${encodeTomlValue(value)}`);
    }
  }

  for (const [key, value] of tables) {
    writeTable(lines, [...path, key], value);
  }
}

function encodeTomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return `[${value.map((item) => encodeTomlValue(item)).join(", ")}]`;
  }
  if (isPlainObject(value)) {
    const inner = Object.entries(value)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${escapeTomlKey(k)} = ${encodeTomlValue(v)}`)
      .join(", ");
    return `{ ${inner} }`;
  }
  return JSON.stringify(String(value));
}

function escapeTomlKey(key: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) return key;
  return JSON.stringify(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return undefined;
  }
  return value;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(rec)) {
    if (typeof item === "string") out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
