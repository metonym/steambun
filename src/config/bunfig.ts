import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isBunPlugin, isSteambunHooks } from "../util/plugins";
import { toImportSpecifier } from "../util/specifier";
import type {
  AppType,
  BuildOptions,
  CompileOptions,
  CompileWindowsOptions,
  HttpsOptions,
  MinifyObject,
  Plugin,
  PreviewOptions,
  ProxyEntry,
  ProxyOptions,
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
export function bunfigToUserConfig(
  raw: unknown,
  warn: WarnFn = console.warn,
): UserConfig {
  const root = asRecord(raw) ?? {};
  const native = nativeBunfigToUserConfig(root, warn);
  const steambun = mapSteambunTable(asRecord(root.steambun) ?? {}, warn);
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

type WarnFn = (message: string) => void;

/**
 * A decoder validates one raw TOML value into `T`, returning `undefined`
 * (and warning through `warn`, for container decoders that check each of
 * their own entries) when the value doesn't fit. `decodeTable` uses
 * `.expected` to report a decoder's expected shape when it rejects a value
 * outright.
 */
type Decoder<T> = ((
  value: unknown,
  path: string,
  warn: WarnFn,
) => T | undefined) & { expected?: string; silent?: boolean };

type KeyTable<T> = { [K in keyof Required<T>]: Decoder<T[K]> };

function withExpected<T>(
  fn: (value: unknown, path: string, warn: WarnFn) => T | undefined,
  expected: string,
): Decoder<T> {
  const decoder = fn as Decoder<T>;
  decoder.expected = expected;
  return decoder;
}

/**
 * Wraps a decoder so `decodeTable` never prints its generic "expected X, got
 * Y" message on rejection — for the rare decoder (just `compile`, so far)
 * that must stay exactly as silent as its hand-written predecessor.
 */
function silent<T>(decoder: Decoder<T>): Decoder<T> {
  const wrapped: Decoder<T> = (value, path, warn) => decoder(value, path, warn);
  wrapped.expected = decoder.expected;
  wrapped.silent = true;
  return wrapped;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Decodes every key of `raw` against `table`, warning once per key that is
 * either absent from `table` (`Unknown bunfig key`) or rejected by its
 * decoder (`expected X, got Y`). Container decoders (`nested`, `record`)
 * recurse into this for their own tables, so warnings carry the full
 * dotted path.
 */
function decodeTable<T>(
  raw: Record<string, unknown>,
  table: KeyTable<T>,
  path: string,
  warn: WarnFn,
): Partial<T> {
  const out: Partial<T> = {};
  const decoders = table as Record<string, Decoder<unknown>>;
  for (const [key, value] of Object.entries(raw)) {
    const keyPath = `${path}.${key}`;
    const decoder = decoders[key];
    if (!decoder) {
      warn(`[steambun] Unknown bunfig key "${keyPath}" was ignored.`);
      continue;
    }
    const decoded = decoder(value, keyPath, warn);
    if (decoded === undefined) {
      if (!decoder.silent) {
        warn(
          `[steambun] bunfig key "${keyPath}" expected ${decoder.expected ?? "a different type"}, got ${describeType(value)} — ignored.`,
        );
      }
      continue;
    }
    (out as Record<string, unknown>)[key] = decoded;
  }
  return out;
}

const bool: Decoder<boolean> = withExpected(
  (value) => (typeof value === "boolean" ? value : undefined),
  "boolean",
);
const str: Decoder<string> = withExpected(
  (value) => (typeof value === "string" ? value : undefined),
  "string",
);
const num: Decoder<number> = withExpected(
  (value) => (typeof value === "number" ? value : undefined),
  "number",
);
const strArray: Decoder<string[]> = withExpected(
  (value) => asStringArray(value),
  "string[]",
);

function oneOf<T>(...values: T[]): Decoder<T> {
  return withExpected(
    (value) => (values.includes(value as T) ? (value as T) : undefined),
    values.map((value) => JSON.stringify(value)).join(" | "),
  );
}

function union<A, B>(a: Decoder<A>, b: Decoder<B>): Decoder<A | B> {
  return withExpected(
    (value, path, warn) => {
      const decoded = a(value, path, warn);
      return decoded !== undefined ? decoded : b(value, path, warn);
    },
    `${a.expected ?? "value"} or ${b.expected ?? "value"}`,
  );
}

/**
 * A record whose keys are unknown ahead of time (`define`, `headers`,
 * `alias`, ...): every entry is decoded with `valueDecoder`, warning and
 * dropping only the entries that don't fit rather than the whole table.
 */
function record<V>(valueDecoder: Decoder<V>): Decoder<Record<string, V>> {
  return withExpected((value, path, warn) => {
    const rec = asRecord(value);
    if (!rec) return undefined;
    const out: Record<string, V> = {};
    for (const [key, item] of Object.entries(rec)) {
      const keyPath = `${path}.${key}`;
      const decoded = valueDecoder(item, keyPath, warn);
      if (decoded === undefined) {
        warn(
          `[steambun] bunfig key "${keyPath}" expected ${valueDecoder.expected ?? "a different type"}, got ${describeType(item)} — ignored.`,
        );
        continue;
      }
      out[key] = decoded;
    }
    return out;
  }, "object");
}

const strRecord: Decoder<Record<string, string>> = record(str);

/**
 * A nested `[steambun.*]` table, decoded with its own `KeyTable`. Returns
 * `{}` (not `undefined`) when every entry was rejected — those entries
 * already warned individually, so the caller shouldn't warn again about the
 * table itself being the wrong shape.
 */
function nested<T>(table: KeyTable<T>): Decoder<T> {
  return withExpected((value, path, warn) => {
    const rec = asRecord(value);
    if (!rec) return undefined;
    return decodeTable(rec, table, path, warn) as T;
  }, "object");
}

const PROXY_TABLE: KeyTable<Omit<ProxyOptions, "rewrite">> = {
  target: str,
  changeOrigin: bool,
  ws: bool,
};

const proxyEntry: Decoder<ProxyEntry> = withExpected((value, path, warn) => {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return undefined;
  const { rewrite, ...rest } = rec;
  if (rewrite !== undefined) {
    warn(
      `[steambun] bunfig key "${path}.rewrite" requires a TypeScript config and was ignored.`,
    );
  }
  const decoded = decodeTable(rest, PROXY_TABLE, path, warn);
  return typeof decoded.target === "string"
    ? (decoded as ProxyOptions)
    : undefined;
}, "string or object");

const HTTPS_TABLE: KeyTable<HttpsOptions> = {
  key: str,
  cert: str,
  passphrase: str,
  ca: union(str, strArray),
};

const httpsEntry: Decoder<HttpsOptions> = withExpected((value, path, warn) => {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const decoded = decodeTable(rec, HTTPS_TABLE, path, warn);
  return typeof decoded.key === "string" && typeof decoded.cert === "string"
    ? (decoded as HttpsOptions)
    : undefined;
}, "object");

const SERVER_TABLE: KeyTable<ServerOptions> = {
  port: num,
  host: union(bool, str),
  open: union(bool, str),
  cors: bool,
  headers: strRecord,
  proxy: record(proxyEntry),
  https: httpsEntry,
  idleTimeout: num,
  maxRequestBodySize: num,
  strictPort: bool,
};

const PREVIEW_TABLE: KeyTable<PreviewOptions> = {
  port: num,
  host: union(bool, str),
  open: union(bool, str),
  strictPort: bool,
};

const RESOLVE_TABLE: KeyTable<ResolveOptions> = {
  alias: strRecord,
  extensions: strArray,
  viteSuffixes: bool,
};

const MINIFY_OBJECT_TABLE: KeyTable<MinifyObject> = {
  whitespace: bool,
  syntax: bool,
  identifiers: bool,
  keepNames: bool,
};

const SHARED_CSS_TABLE: KeyTable<{ minSize: number }> = {
  minSize: num,
};

const PRECOMPRESS_ENCODINGS = ["gzip", "br", "zstd"] as const;
type PrecompressEncoding = (typeof PRECOMPRESS_ENCODINGS)[number];

const precompress: Decoder<false | PrecompressEncoding[]> = withExpected(
  (value, path, warn) => {
    if (value === false) return false;
    if (!Array.isArray(value)) return undefined;
    const out: PrecompressEncoding[] = [];
    value.forEach((item, index) => {
      if ((PRECOMPRESS_ENCODINGS as readonly unknown[]).includes(item)) {
        out.push(item as PrecompressEncoding);
      } else {
        warn(
          `[steambun] bunfig key "${path}[${index}]" has an unknown precompress encoding ${JSON.stringify(item)} — ignored.`,
        );
      }
    });
    return out;
  },
  `false or an array of ${PRECOMPRESS_ENCODINGS.map((encoding) => JSON.stringify(encoding)).join(" | ")}`,
);

const BUILD_TABLE: KeyTable<BuildOptions> = {
  outDir: str,
  assetsDir: str,
  sourcemap: union(bool, oneOf<"inline" | "external">("inline", "external")),
  minify: union(
    bool,
    union(
      oneOf<"esbuild" | "terser">("esbuild", "terser"),
      nested(MINIFY_OBJECT_TABLE),
    ),
  ),
  drop: strArray,
  standalone: bool,
  manifest: bool,
  target: oneOf<"browser" | "bun" | "node">("browser", "bun", "node"),
  bytecode: bool,
  splitting: bool,
  budgets: record(union(str, num)),
  cssChunking: bool,
  minChunkSize: num,
  importMap: bool,
  sharedCss: union(bool, nested(SHARED_CSS_TABLE)),
  precompress,
  precompressMinSize: num,
  server: bool,
  sri: bool,
  csp: union(oneOf<false | "strict">(false, "strict"), record(strArray)),
};

const COMPILE_WINDOWS_TABLE: KeyTable<CompileWindowsOptions> = {
  icon: str,
  hideConsole: bool,
  title: str,
  publisher: str,
  version: str,
  description: str,
  copyright: str,
};

const COMPILE_TABLE: KeyTable<CompileOptions> = {
  targets: strArray,
  outDir: str,
  autoloadDotenv: bool,
  autoloadBunfig: bool,
  windows: nested(COMPILE_WINDOWS_TABLE),
};

/**
 * `resolveDefaults` treats an empty `{}` as "compile enabled with defaults",
 * unlike other nested tables, so — unlike `nested()` — an empty
 * `[steambun.compile]` (no keys, or every key rejected) must decode to
 * `undefined` rather than `{}`.
 */
const compileTable: Decoder<CompileOptions> = withExpected(
  (value, path, warn) => {
    const rec = asRecord(value);
    if (!rec) return undefined;
    const decoded = decodeTable(rec, COMPILE_TABLE, path, warn);
    return Object.keys(decoded).length > 0
      ? (decoded as CompileOptions)
      : undefined;
  },
  "object",
);

interface SteambunTopFields {
  base: string;
  publicDir: string | false;
  appType: AppType;
  api: string;
  compile: boolean | CompileOptions;
  features: string[];
  envDir: string;
  envPrefix: string | string[];
  define: Record<string, string>;
  server: ServerOptions;
  build: BuildOptions;
  preview: PreviewOptions;
  resolve: ResolveOptions;
  middleware: string[];
  plugins: string[];
}

const STEAMBUN_TABLE: KeyTable<SteambunTopFields> = {
  base: str,
  publicDir: union(oneOf<false>(false), str),
  appType: oneOf<AppType>("spa", "mpa"),
  api: str,
  compile: silent(union(bool, compileTable)),
  features: strArray,
  envDir: str,
  envPrefix: union(str, strArray),
  define: strRecord,
  server: nested(SERVER_TABLE),
  build: nested(BUILD_TABLE),
  preview: nested(PREVIEW_TABLE),
  resolve: nested(RESOLVE_TABLE),
  // Specifiers only — resolved to plugins/functions by loadBunfigPlugins /
  // resolveBunfigModules, not part of the decoded UserConfig itself.
  middleware: strArray,
  plugins: strArray,
};

function nativeBunfigToUserConfig(
  root: Record<string, unknown>,
  warn: WarnFn,
): UserConfig {
  const config: UserConfig = {};
  if (root.define !== undefined) {
    const define = strRecord(root.define, "define", warn);
    if (define) config.define = define;
  }

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

function mapSteambunTable(
  raw: Record<string, unknown>,
  warn: WarnFn,
): UserConfig {
  const decoded = decodeTable(raw, STEAMBUN_TABLE, "steambun", warn);
  const { plugins: _plugins, middleware: _middleware, ...config } = decoded;
  return config;
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

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
