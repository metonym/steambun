import { existsSync } from "node:fs";
import { join } from "node:path";

const ENTRY_HEAD = /[ \t]*(?:export[ \t]+)?([\w.-]+)[ \t]*=[ \t]*/y;
const QUOTES = new Set(["'", '"', "`"]);
const AFTER_QUOTE = /^[ \t]*(?:#.*)?$/;

/** dotenv/Vite syntax: `[export] KEY=value`, `#` comments, quoted values, no interpolation. */
export function parseEnvFile(contents: string): Record<string, string> {
  const src = contents.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < src.length) {
    let eol = src.indexOf("\n", pos);
    if (eol === -1) eol = src.length;
    ENTRY_HEAD.lastIndex = pos;
    const head = ENTRY_HEAD.exec(src);
    if (head) {
      const valStart = pos + head[0].length;
      const quote = src[valStart];
      let value: string | undefined;
      if (QUOTES.has(quote)) {
        // A quoted value may span lines, so find the closing quote across the rest of the file.
        let close = valStart + 1;
        while (close < src.length && src[close] !== quote) {
          close += src[close] === "\\" && src[close + 1] === quote ? 2 : 1;
        }
        if (close < src.length) {
          let lineEnd = src.indexOf("\n", close);
          if (lineEnd === -1) lineEnd = src.length;
          if (AFTER_QUOTE.test(src.slice(close + 1, lineEnd))) {
            value = src.slice(valStart + 1, close);
            if (quote === '"') {
              value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
            }
            eol = lineEnd;
          }
        }
      }
      // An unquoted value, or a quote with no valid close, ends at the first `#`.
      value ??= src.slice(valStart, eol).replace(/#.*/, "").trim();
      out[head[1]] = value;
    }
    pos = eol + 1;
  }
  return out;
}

/** `.env`, `.env.local`, `.env.[mode]`, `.env.[mode].local`, later overriding earlier. Excludes `process.env` so shell vars stay out of generated types. */
export async function loadEnvFiles(
  mode: string,
  envDir: string,
): Promise<Record<string, string>> {
  const files = [".env", ".env.local", `.env.${mode}`, `.env.${mode}.local`];
  const merged: Record<string, string> = {};

  for (const file of files) {
    const path = join(envDir, file);
    if (!existsSync(path)) continue;
    const parsed = parseEnvFile(await Bun.file(path).text());
    Object.assign(merged, parsed);
  }

  return merged;
}

/** `process.env` always wins over file values. */
export function withProcessEnv(
  fileEnv: Record<string, string>,
): Record<string, string> {
  const env = { ...fileEnv };
  for (const key in process.env) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function filterPublicEnv(
  env: Record<string, string>,
  prefixes: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key in env) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      out[key] = env[key];
    }
  }
  return out;
}

interface ImportMetaEnvOptions {
  mode: string;
  command: "dev" | "build";
  base: string;
}

// Like Vite, `build` is always production whatever `--mode` says; `dev` is production only for `--mode production`.
function isProduction(opts: ImportMetaEnvOptions): boolean {
  return opts.command === "build" || opts.mode === "production";
}

// Bun's `env` option only inlines process.env.*, so import.meta.env.* goes through define.
// `typedPublicEnv` (envSchema output) replaces the raw strings for import.meta.env only;
// process.env.* stays the raw environment.
export function buildImportMetaEnvDefine(
  publicEnv: Record<string, string>,
  opts: ImportMetaEnvOptions,
  typedPublicEnv?: Record<string, unknown>,
): Record<string, string> {
  const production = isProduction(opts);
  const define: Record<string, string> = {
    "import.meta.env.MODE": JSON.stringify(opts.mode),
    "import.meta.env.DEV": JSON.stringify(!production),
    "import.meta.env.PROD": JSON.stringify(production),
    "import.meta.env.SSR": "false",
    "import.meta.env.BASE_URL": JSON.stringify(opts.base),
  };
  for (const key in publicEnv) {
    const value = JSON.stringify(publicEnv[key]);
    define[`import.meta.env.${key}`] = value;
    define[`process.env.${key}`] = value;
  }
  for (const key in typedPublicEnv) {
    define[`import.meta.env.${key}`] = JSON.stringify(typedPublicEnv[key]);
  }
  return define;
}

const IMPORT_META_ENV = "import.meta.env";

// Object literal of every `import.meta.env.KEY` define, so a bare `import.meta.env` (spread,
// `Object.keys`, `in`) sees the same values. Omitted if a value isn't JSON, which Bun requires of defines.
function importMetaEnvObject(
  define: Record<string, string>,
): string | undefined {
  const entries: string[] = [];
  for (const key in define) {
    if (!key.startsWith(`${IMPORT_META_ENV}.`)) continue;
    try {
      JSON.parse(define[key]);
    } catch {
      return undefined;
    }
    entries.push(
      `${JSON.stringify(key.slice(IMPORT_META_ENV.length + 1))}:${define[key]}`,
    );
  }
  return `{${entries.join(",")}}`;
}

/** `base` with a trailing slash, so built asset URLs are absolute and work from nested pages. */
export function toPublicPath(base: string): string {
  return base.endsWith("/") ? base : `${base}/`;
}

export function buildBundleDefine(
  publicEnv: Record<string, string>,
  opts: ImportMetaEnvOptions,
  userDefine?: Record<string, string>,
  typedPublicEnv?: Record<string, unknown>,
): Record<string, string> {
  const define = {
    ...buildImportMetaEnvDefine(publicEnv, opts, typedPublicEnv),
    ...userDefine,
  };
  if (!(IMPORT_META_ENV in define)) {
    const object = importMetaEnvObject(define);
    if (object) define[IMPORT_META_ENV] = object;
  }
  if (!("process.env.NODE_ENV" in define)) {
    define["process.env.NODE_ENV"] = JSON.stringify(
      isProduction(opts) ? "production" : "development",
    );
  }
  return define;
}
