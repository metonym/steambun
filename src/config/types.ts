import type { App } from "../runtime/app";

export type Command = "dev" | "build" | "preview";
export type Mode = string;
export type AppType = "spa" | "mpa";

export interface ProxyOptions {
  target: string;
  changeOrigin?: boolean;
  rewrite?: (path: string) => string;
  ws?: boolean;
}

export type ProxyEntry = string | ProxyOptions;

export interface HttpsOptions {
  key: string;
  cert: string;
  ca?: string | string[];
  passphrase?: string;
}

export interface ServerOptions {
  port?: number;
  host?: string | boolean;
  open?: boolean | string;
  cors?: boolean;
  headers?: Record<string, string>;
  proxy?: Record<string, ProxyEntry>;
  /** Paths are resolved against `root`. Maps to `Bun.serve({ tls })`. */
  https?: HttpsOptions;
  /** Seconds of inactivity before Bun closes the connection. Default 10. */
  idleTimeout?: number;
  /** Max request body size in bytes. Bun default is 128MB. */
  maxRequestBodySize?: number;
}

export interface MinifyObject {
  whitespace?: boolean;
  syntax?: boolean;
  identifiers?: boolean;
  keepNames?: boolean;
}

/** Vite `esbuild`/`terser` aliases map to Bun's minifier; `terser` warns once. */
export type MinifyOption = boolean | "esbuild" | "terser" | MinifyObject;

export interface BuildOptions {
  outDir?: string;
  assetsDir?: string;
  sourcemap?: boolean | "inline" | "external";
  minify?: MinifyOption;
  /** Defaults to `["debugger"]` in production. */
  drop?: string[];
  /** Bundles each HTML entry into one self-contained `.html` file. Distinct from top-level `compile`, which produces a single-binary server. */
  standalone?: boolean;
  manifest?: boolean;
  /** Bun build target. HTML builds default to `"browser"`. */
  target?: "browser" | "bun" | "node";
  /** Bun bytecode cache. Only applied when `compile: true`. */
  bytecode?: boolean;
  /** Maps to `Bun.build({ splitting })`. Default off. Ignored for `standalone` and `compile`. */
  splitting?: boolean;
  /** Glob → max size ("250kb", "1.5mb", or bytes). Build fails when exceeded. Checked on raw (uncompressed) sizes. */
  budgets?: Record<string, string | number>;
  /** Maps to `Bun.build({ cssChunking })`. Only effective with multiple CSS-importing entries. */
  cssChunking?: boolean;
  /** Maps to `Bun.build({ minChunkSize })`. Requires `splitting`. */
  minChunkSize?: number;
  /** Encodings to precompute for files under `assetsDir` (and `publicDir` copies) larger than `precompressMinSize`. Default `false`. */
  precompress?: false | Array<"gzip" | "br" | "zstd">;
  /** Default `1024`. */
  precompressMinSize?: number;
  /** Write `dist/server.js`, a self-contained preview server. Default `true`. */
  server?: boolean;
  /** Adds `integrity`/`crossorigin` to local `<script src>` and `<link rel="stylesheet">` tags. Default `false`. */
  sri?: boolean;
  /**
   * Writes `outDir/_headers.json` with a `Content-Security-Policy` for
   * `"*.html"`, built from hashes of every inline `<script>`/`<style>`.
   * `"strict"` is `default-src 'self'; script-src 'self' <hashes>;
   * style-src 'self' <hashes>; object-src 'none'; base-uri 'self'`. An
   * object's directives are merged with the computed hashes. Default `false`.
   */
  csp?: false | "strict" | Record<string, string[]>;
}

export interface ResolveOptions {
  alias?: Record<string, string>;
  /** Accepted for Vite configs. Bun already resolves `.ts` / `.tsx` / `.js` / `.jsx` / `.json`. */
  extensions?: string[];
}

export interface PreviewOptions {
  port?: number;
  host?: string | boolean;
  open?: boolean | string;
}

// Aliases Bun's own ambient type rather than redeclaring `setup`'s `build`
// param as `unknown`, which made real plugins structurally incompatible.
export type BunPlugin = globalThis.Bun.BunPlugin;

export interface SteambunHooks {
  name?: string;
  /** Runs at the end of `loadConfig`, once per hook plugin. */
  configResolved?: (config: ResolvedConfig) => void | Promise<void>;
  /** Runs at the end of `createApp`, before `serveOptions` is frozen — add routes/middleware. */
  configureApp?: (
    app: App,
    ctx: { mode: "dev" | "preview" },
  ) => void | Promise<void>;
  /** Runs before `Bun.build()` for the HTML entries. */
  buildStart?: (ctx: {
    config: ResolvedConfig;
    entrypoints: string[];
  }) => void | Promise<void>;
  transformHtml?: (
    html: string,
    ctx: { path: string },
  ) => string | Promise<string>;
  onBuildEnd?: (artifacts: unknown) => void | Promise<void>;
  /** Runs after `build()` finishes writing `outDir` (after `onBuildEnd`). */
  closeBundle?: (ctx: { outDir: string }) => void | Promise<void>;
}

export type Plugin = BunPlugin | SteambunHooks;

export interface CompileWindowsOptions {
  icon?: string;
  hideConsole?: boolean;
  title?: string;
  publisher?: string;
  version?: string;
  description?: string;
  copyright?: string;
}

export interface CompileOptions {
  /** Cross-compile targets, e.g. `["bun-linux-x64", "bun-darwin-arm64"]`. Default: host only. */
  targets?: string[];
  /** Default `"bin"`. */
  outDir?: string;
  windows?: CompileWindowsOptions;
  /** Whether the binary loads `.env` files at runtime. Bun defaults this to `true`; steambun defaults to `false` — a compiled server should get its config from real env vars, not files that may not ship with it. */
  autoloadDotenv?: boolean;
  /** Whether the binary loads `bunfig.toml` at runtime. Default `true` (Bun's default). */
  autoloadBunfig?: boolean;
}

export interface UserConfig {
  root?: string;
  base?: string;
  publicDir?: string | false;
  plugins?: Plugin[];
  server?: ServerOptions;
  build?: BuildOptions;
  preview?: PreviewOptions;
  resolve?: ResolveOptions;
  define?: Record<string, string>;
  envPrefix?: string | string[];
  envDir?: string;
  /**
   * After file lookup, unmatched paths get `index.html` (`spa`) or 404 (`mpa`).
   * Applies to `dev`, `preview`, and `compile`. Default `"spa"`.
   */
  appType?: AppType;

  /** Directory of file-based API routes -> Bun.serve routes. */
  api?: string;
  /** (req, next) => Response | Promise<Response>. */
  middleware?: unknown[];
  compile?: boolean | CompileOptions;
  /**
   * Bun `--feature` flags for `bun:bundle` dead-code elimination. Merges
   * with the `STEAMBUN_FEATURES` env var (comma-separated) in `dev` and
   * `build`. `dev` reflects only the env var — see the README.
   */
  features?: string[];
}

export type ConfigEnv = { command: Command; mode: Mode };

export type UserConfigFn = (env: ConfigEnv) => UserConfig | Promise<UserConfig>;

export type UserConfigExport = UserConfig | Promise<UserConfig> | UserConfigFn;

/**
 * Identity helper for config authoring — gives `steambun.config.ts` full
 * type-checking and autocomplete, mirroring Vite's `defineConfig`.
 *
 * @example
 * ```ts
 * import { defineConfig } from "steambun";
 *
 * export default defineConfig(({ mode }) => ({
 *   server: { port: 5173, proxy: { "/api": "http://localhost:8080" } },
 *   build: { manifest: true },
 * }));
 * ```
 */
export function defineConfig(config: UserConfigExport): UserConfigExport {
  return config;
}

export interface ResolvedConfig extends UserConfig {
  root: string;
  base: string;
  publicDir: string | false;
  appType: AppType;
  mode: Mode;
  command: Command;
  configFile: string | null;
  server: Required<Pick<ServerOptions, "port" | "host" | "cors">> &
    ServerOptions;
  build: Required<
    Pick<
      BuildOptions,
      | "outDir"
      | "assetsDir"
      | "sourcemap"
      | "minify"
      | "manifest"
      | "drop"
      | "standalone"
      | "precompress"
      | "precompressMinSize"
      | "server"
    >
  > &
    BuildOptions;
  envPrefix: string[];
  /** Normalized from `boolean | CompileOptions`: `true` becomes `{}`. */
  compile?: false | CompileOptions;
}
