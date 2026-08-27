import { existsSync } from "node:fs";
import { join } from "node:path";

function isWs(c: number): boolean {
  return c === 32 || c === 9;
}

function parseLine(
  contents: string,
  start: number,
  end: number,
  out: Record<string, string>,
): void {
  while (start < end && isWs(contents.charCodeAt(start))) start++;
  while (end > start && isWs(contents.charCodeAt(end - 1))) end--;
  if (start >= end || contents.charCodeAt(start) === 35) return;

  const eq = contents.indexOf("=", start);
  if (eq === -1 || eq >= end) return;

  let keyEnd = eq;
  while (keyEnd > start && isWs(contents.charCodeAt(keyEnd - 1))) keyEnd--;
  let valStart = eq + 1;
  while (valStart < end && isWs(contents.charCodeAt(valStart))) valStart++;
  let valEnd = end;
  if (valEnd - valStart >= 2) {
    const q = contents.charCodeAt(valStart);
    if ((q === 34 || q === 39) && contents.charCodeAt(valEnd - 1) === q) {
      valStart++;
      valEnd--;
    }
  }
  out[contents.slice(start, keyEnd)] = contents.slice(valStart, valEnd);
}

/** Minimal .env parser: KEY=VALUE per line, '#' comments, optional quotes. No interpolation. */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  const len = contents.length;
  let start = 0;
  for (let i = 0; i <= len; i++) {
    const c = i === len ? 10 : contents.charCodeAt(i);
    if (c !== 10 && c !== 13) continue;
    if (i > start) parseLine(contents, start, i, out);
    if (c === 13 && i + 1 < len && contents.charCodeAt(i + 1) === 10) i++;
    start = i + 1;
  }
  return out;
}

/** Keys from `.env*` files only. Used for generated types so a machine's `VITE_*` shell vars stay out of `.steambun/env.d.ts`. */
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

// .env, .env.local, .env.[mode], .env.[mode].local, later overriding earlier
// (Vite's precedence). process.env always wins.
export async function loadEnv(
  mode: string,
  envDir: string,
): Promise<Record<string, string>> {
  return withProcessEnv(await loadEnvFiles(mode, envDir));
}

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

export interface ImportMetaEnvOptions {
  mode: string;
  command: "dev" | "build" | "preview";
  base: string;
}

// Bun only inlines process.env.* via --env, leaving import.meta.env
// untouched, so its rewriting goes through this define map instead.
export function buildImportMetaEnvDefine(
  publicEnv: Record<string, string>,
  opts: ImportMetaEnvOptions,
): Record<string, string> {
  const isDev = opts.command === "dev";
  const define: Record<string, string> = {
    "import.meta.env.MODE": JSON.stringify(opts.mode),
    "import.meta.env.DEV": JSON.stringify(isDev),
    "import.meta.env.PROD": JSON.stringify(!isDev),
    "import.meta.env.SSR": JSON.stringify(false),
    "import.meta.env.BASE_URL": JSON.stringify(opts.base),
  };
  for (const key in publicEnv) {
    const value = JSON.stringify(publicEnv[key]);
    define[`import.meta.env.${key}`] = value;
    define[`process.env.${key}`] = value;
  }
  return define;
}

/** Bun `[serve.static] env` / `Bun.build({ env })` accepts one `PREFIX_*` glob. */
export function toBunEnvPattern(prefixes: string[]): `${string}*` | undefined {
  if (prefixes.length !== 1) return undefined;
  const prefix = prefixes[0];
  if (!prefix) return undefined;
  return `${prefix}*`;
}

export function toPublicPath(base: string): string | undefined {
  if (!base || base === "/") return undefined;
  return base.endsWith("/") ? base : `${base}/`;
}

export function buildBundleDefine(
  publicEnv: Record<string, string>,
  opts: ImportMetaEnvOptions,
  userDefine?: Record<string, string>,
): Record<string, string> {
  const define = {
    ...buildImportMetaEnvDefine(publicEnv, opts),
    ...userDefine,
  };
  if (!("process.env.NODE_ENV" in define)) {
    define["process.env.NODE_ENV"] = JSON.stringify(
      opts.mode === "production" ? "production" : "development",
    );
  }
  return define;
}
