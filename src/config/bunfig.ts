import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Middleware } from "../runtime/middleware";
import { asRecord, asStringArray, isPlainObject } from "../util/guards";
import { isBunPlugin } from "../util/plugins";
import { toImportSpecifier } from "../util/specifier";
import { log } from "../util/terminal";
import type {
  BuildOptions,
  BunPlugin,
  CompileOptions,
  CompileWindowsOptions,
  HttpsOptions,
  MinifyObject,
  ProxyEntry,
  ProxyOptions,
  ResolveOptions,
  ServerOptions,
  UserConfig,
} from "./types";

type WarnFn = (message: string) => void;

export function isTomlConfigPath(path: string): boolean {
  return path.endsWith(".toml");
}

export function projectBunfigPath(root: string): string {
  return join(root, "bunfig.toml");
}

const steambunTable = (raw: unknown) => asRecord(asRecord(raw)?.steambun) ?? {};
const staticTable = (raw: unknown) =>
  asRecord(asRecord(asRecord(raw)?.serve)?.static) ?? {};

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

/** Data-only mapping; middleware specifiers are loaded by {@link resolveBunfigModules}. */
export function bunfigToUserConfig(
  raw: unknown,
  warn: WarnFn = log.warn,
): UserConfig {
  const root = asRecord(raw) ?? {};
  const native = nativeBunfigToUserConfig(root, warn);
  const config = mapSteambunTable(steambunTable(root), warn);
  // The native keys only populate define/server.port/envPrefix; [steambun] wins on overlap.
  if (native.define) config.define = { ...native.define, ...config.define };
  if (native.server) config.server = { ...native.server, ...config.server };
  if (native.envPrefix && !config.envPrefix)
    config.envPrefix = native.envPrefix;
  return config;
}

/** Imports `[steambun] middleware` specifiers and prepends them to `config.middleware`. */
export async function resolveBunfigModules(
  config: UserConfig,
  raw: unknown,
  root: string,
): Promise<UserConfig> {
  const specs = asStringArray(steambunTable(raw).middleware) ?? [];
  if (specs.length === 0) return config;
  const middleware = await importDefaults(
    root,
    specs,
    "middleware",
    (value): value is Middleware => typeof value === "function",
  );
  return {
    ...config,
    middleware: [...middleware, ...(config.middleware ?? [])],
  };
}

/** The bunfig Bun itself reads alongside steambun: `--config x.toml`, else the project's. */
export async function readUserBunfig(
  root: string,
  configFile: string | null,
): Promise<Record<string, unknown> | null> {
  const tomlConfig =
    configFile && isTomlConfigPath(configFile) ? configFile : null;
  return readBunfigFile(tomlConfig ?? projectBunfigPath(root));
}

/** Bun plugins named by `[serve.static] plugins`, which Bun itself loads in `dev`. */
export async function loadBunfigPlugins(
  root: string,
  configFile: string | null,
): Promise<BunPlugin[]> {
  const raw = await readUserBunfig(root, configFile);
  if (!raw) return [];
  return importDefaults(
    root,
    asStringArray(staticTable(raw).plugins) ?? [],
    "plugin",
    isBunPlugin,
  );
}

export function relocateBunfigPaths(
  raw: Record<string, unknown>,
  fromRoot: string,
  toDir: string,
): Record<string, unknown> {
  const out = structuredClone(raw);
  const relocateIn = (
    table: Record<string, unknown> | undefined,
    key: string,
  ) => {
    const specs = asStringArray(table?.[key]);
    if (table && specs) {
      table[key] = specs.map((spec) =>
        relocateSpecifier(spec, fromRoot, toDir),
      );
    }
  };

  relocateIn(out, "preload");
  relocateIn(asRecord(out.test), "preload");
  relocateIn(asRecord(asRecord(out.serve)?.static), "plugins");
  return out;
}

export function serializeMergedBunfig(
  userRaw: Record<string, unknown>,
  generatedPlugins: string[],
): string {
  const { steambun: _steambun, ...merged } = userRaw;
  const serve = asRecord(merged.serve) ?? {};
  merged.serve = {
    ...serve,
    static: {
      ...staticTable(userRaw),
      plugins: [
        ...new Set([
          ...(asStringArray(staticTable(userRaw).plugins) ?? []),
          ...generatedPlugins,
        ]),
      ],
    },
  };
  return stringifyToml(merged);
}

export function stringifyToml(root: Record<string, unknown>): string {
  const lines: string[] = [];
  writeTable(lines, [], root);
  while (lines[0] === "") lines.shift();
  return `${lines.join("\n")}\n`;
}

/** Returns `undefined` when the value doesn't fit; container decoders warn per rejected entry themselves. */
type Decoder<T> = ((
  value: unknown,
  path: string,
  warn: WarnFn,
) => T | undefined) & { expected?: string };

type KeyTable<T> = { [K in keyof Required<T>]: Decoder<T[K]> };

function withExpected<T>(
  fn: (value: unknown, path: string, warn: WarnFn) => T | undefined,
  expected: string,
): Decoder<T> {
  const decoder = fn as Decoder<T>;
  decoder.expected = expected;
  return decoder;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function decodeEntry<T>(
  decoder: Decoder<T>,
  value: unknown,
  path: string,
  warn: WarnFn,
): T | undefined {
  const decoded = decoder(value, path, warn);
  if (decoded === undefined) {
    warn(
      `[steambun] bunfig key "${path}" expected ${decoder.expected ?? "a different type"}, got ${describeType(value)} — ignored.`,
    );
  }
  return decoded;
}

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
    const decoder = Object.hasOwn(decoders, key) ? decoders[key] : undefined;
    if (!decoder) {
      warn(`[steambun] Unknown bunfig key "${keyPath}" was ignored.`);
      continue;
    }
    const decoded = decodeEntry(decoder, value, keyPath, warn);
    if (decoded !== undefined) (out as Record<string, unknown>)[key] = decoded;
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

function oneOf<const T extends readonly (string | boolean)[]>(
  ...values: T
): Decoder<T[number]> {
  return withExpected(
    (value) =>
      values.includes(value as T[number]) ? (value as T[number]) : undefined,
    values.map((value) => JSON.stringify(value)).join(" | "),
  );
}

function union<T extends unknown[]>(
  ...decoders: { [K in keyof T]: Decoder<T[K]> }
): Decoder<T[number]> {
  return withExpected(
    (value, path, warn) => {
      for (const decoder of decoders as Decoder<unknown>[]) {
        const decoded = decoder(value, path, warn);
        if (decoded !== undefined) return decoded as T[number];
      }
      return undefined;
    },
    (decoders as Decoder<unknown>[])
      .map((decoder) => decoder.expected ?? "value")
      .join(" or "),
  );
}

/** Open-keyed table (`define`, `headers`, ...): entries that don't fit are dropped individually. */
function record<V>(valueDecoder: Decoder<V>): Decoder<Record<string, V>> {
  return withExpected((value, path, warn) => {
    const rec = asRecord(value);
    if (!rec) return undefined;
    const out: Record<string, V> = {};
    for (const [key, item] of Object.entries(rec)) {
      const decoded = decodeEntry(valueDecoder, item, `${path}.${key}`, warn);
      if (decoded !== undefined) out[key] = decoded;
    }
    return out;
  }, "object");
}

const strRecord: Decoder<Record<string, string>> = record(str);

/** Returns `{}` (not `undefined`) when every entry was rejected, since each already warned. */
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
  allowedHosts: union(oneOf(true), strArray),
};

const RESOLVE_TABLE: KeyTable<ResolveOptions> = {
  alias: strRecord,
};

const MINIFY_OBJECT_TABLE: KeyTable<MinifyObject> = {
  whitespace: bool,
  syntax: bool,
  identifiers: bool,
  keepNames: bool,
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
  emptyOutDir: bool,
  assetsDir: str,
  sourcemap: union(bool, oneOf("inline", "external")),
  minify: union(bool, nested(MINIFY_OBJECT_TABLE)),
  drop: strArray,
  standalone: bool,
  manifest: bool,
  target: oneOf("browser", "bun", "node"),
  splitting: bool,
  budgets: record(union(str, num)),
  precompress,
  server: bool,
  features: strArray,
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
  bytecode: bool,
  windows: nested(COMPILE_WINDOWS_TABLE),
};

// `{}` means "compile enabled" (like TS `compile: {}`), but a table whose keys were all rejected
// must not silently enable it.
const compileTable: Decoder<CompileOptions> = withExpected(
  (value, path, warn) => {
    const rec = asRecord(value);
    if (!rec) return undefined;
    const decoded = decodeTable(rec, COMPILE_TABLE, path, warn);
    return Object.keys(decoded).length > 0 || Object.keys(rec).length === 0
      ? (decoded as CompileOptions)
      : undefined;
  },
  "object",
);

// Keys a TOML file can't express: `envSchema` and `plugins` are runtime values, and `middleware` is a list of module specifiers.
type SteambunTableFields = Omit<
  UserConfig,
  "envSchema" | "plugins" | "middleware"
> & { middleware: string[] };

const STEAMBUN_TABLE: KeyTable<SteambunTableFields> = {
  base: str,
  publicDir: union(oneOf(false), str),
  appType: oneOf("spa", "mpa"),
  api: str,
  compile: union(bool, compileTable),
  envDir: str,
  envPrefix: union(str, strArray),
  define: strRecord,
  server: nested(SERVER_TABLE),
  build: nested(BUILD_TABLE),
  resolve: nested(RESOLVE_TABLE),
  // Specifiers, imported by resolveBunfigModules rather than decoded into UserConfig.
  middleware: strArray,
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

  const port = asRecord(root.serve)?.port;
  if (typeof port === "number") config.server = { port };

  const env = staticTable(root).env;
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
  const { middleware: _middleware, ...config } = decoded;
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

async function importDefaults<T>(
  root: string,
  specs: string[],
  kind: string,
  isValid: (value: unknown) => value is T,
): Promise<T[]> {
  const out: T[] = [];
  for (const spec of specs) {
    let loaded: unknown;
    try {
      // Resolve from the project, not from steambun's own install location.
      loaded = (await import(Bun.resolveSync(spec, root))).default;
    } catch (err) {
      throw new Error(
        `[steambun] Failed to load bunfig ${kind} "${spec}": ${(err as Error).message}`,
      );
    }
    if (isValid(loaded)) out.push(loaded);
    else {
      log.warn(
        `[steambun] bunfig ${kind} "${spec}" has no valid default export — ignored.`,
      );
    }
  }
  return out;
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
    if (isPlainObject(value)) tables.push([key, value]);
    else scalars.push([key, value]);
  }

  if (scalars.length > 0 && path.length > 0) {
    lines.push("", `[${path.map(escapeTomlKey).join(".")}]`);
  }
  for (const [key, value] of scalars) {
    lines.push(`${escapeTomlKey(key)} = ${encodeTomlValue(value)}`);
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
