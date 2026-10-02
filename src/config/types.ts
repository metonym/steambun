import type { App } from "../runtime/app";
import type { Middleware } from "../runtime/middleware";
import type { StandardSchemaV1 } from "../util/standard-schema";

export type Command = "dev" | "build" | "preview";
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
  /** Paths resolve against `root`. `true` generates a local certificate with mkcert (must be on `PATH`) for `dev` and `preview`. */
  https?: HttpsOptions | true;
  /** Seconds of inactivity before Bun closes the connection. Default 10. */
  idleTimeout?: number;
  /** Max request body size in bytes. Bun default is 128MB. */
  maxRequestBodySize?: number;
  /** Fail instead of trying the next port when `port` is taken. Default `false` for `dev` and `preview`, `true` for `dist/server.js` and compiled binaries. */
  strictPort?: boolean;
}

export interface MinifyObject {
  whitespace?: boolean;
  syntax?: boolean;
  identifiers?: boolean;
  keepNames?: boolean;
}

export type MinifyOption = boolean | MinifyObject;

export interface BuildOptions {
  outDir?: string;
  /** Empty `outDir` before building when it is inside `root`. Default `true`. */
  emptyOutDir?: boolean;
  assetsDir?: string;
  sourcemap?: boolean | "inline" | "external";
  minify?: MinifyOption;
  /** Defaults to `["debugger"]` in production. */
  drop?: string[];
  /** Bundle each HTML entry into one self-contained `.html` file (unrelated to `compile`). */
  standalone?: boolean;
  manifest?: boolean;
  /** Bun build target. HTML builds default to `"browser"`. */
  target?: "browser" | "bun" | "node";
  /** Code splitting into hashed chunks. Default off; ignored for `standalone` and `compile`. */
  splitting?: boolean;
  /** Glob → max raw size (`"250kb"`, `"1.5mb"`, or bytes); the build fails when exceeded. */
  budgets?: Record<string, string | number>;
  /** Encodings to precompute for compressible files. Default `false`. */
  precompress?: false | Array<"gzip" | "br" | "zstd">;
  /** Write `dist/server.js`, a self-contained preview server. Default `true`. */
  server?: boolean;
  /** Bun `--feature` flags for `bun:bundle` dead-code elimination; merged with `STEAMBUN_FEATURES`; `dev` uses only the env var. */
  features?: string[];
}

export interface ResolveOptions {
  alias?: Record<string, string>;
}

// Bun's own type: redeclaring `setup`'s `build` param as `unknown` made real plugins incompatible.
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
  buildStart?: (ctx: { entrypoints: string[] }) => void | Promise<void>;
  transformHtml?: (
    html: string,
    ctx: { path: string },
  ) => string | Promise<string>;
  /** Runs after `build()` finishes writing `outDir` (and compiling, if enabled), and on failure too. */
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
  /** Whether the binary loads `.env` at runtime. Default `false` (Bun's is `true`): a compiled server should read real env vars. */
  autoloadDotenv?: boolean;
  /** Whether the binary loads `bunfig.toml` at runtime. Default `true` (Bun's default). */
  autoloadBunfig?: boolean;
  /** Bun bytecode cache for faster startup. Default `false`. */
  bytecode?: boolean;
}

export interface UserConfig {
  base?: string;
  publicDir?: string | false;
  plugins?: Plugin[];
  server?: ServerOptions;
  build?: BuildOptions;
  resolve?: ResolveOptions;
  define?: Record<string, string>;
  envPrefix?: string | string[];
  envDir?: string;
  /** Standard Schema (zod, valibot, arktype, ...) validating the merged `.env*` + `process.env`; its output types `import.meta.env`. TypeScript config only. */
  envSchema?: StandardSchemaV1;
  /** After file lookup, unmatched paths get `index.html` (`spa`) or 404 (`mpa`). Default `"spa"`. */
  appType?: AppType;
  /** Directory of file-based API routes. */
  api?: string;
  middleware?: Middleware[];
  compile?: boolean | CompileOptions;
}

/** Vite's config-function argument: `preview` is `command: "serve"` with `isPreview: true`. */
export type ConfigEnv = {
  command: "serve" | "build";
  mode: string;
  isPreview: boolean;
};

export type UserConfigFn = (env: ConfigEnv) => UserConfig | Promise<UserConfig>;

export type UserConfigExport = UserConfig | Promise<UserConfig> | UserConfigFn;

/** Identity helper that type-checks `steambun.config.ts`, like Vite's `defineConfig`. */
export function defineConfig<T extends UserConfigExport>(config: T): T {
  return config;
}

/** `UserConfig` with defaults applied; only keys with no meaningful default stay optional. */
export interface ResolvedConfig {
  root: string;
  base: string;
  publicDir: string | false;
  envDir: string;
  appType: AppType;
  mode: string;
  command: Command;
  configFile: string | null;
  plugins: Plugin[];
  middleware: Middleware[];
  define: Record<string, string>;
  envPrefix: string[];
  envSchema?: StandardSchemaV1;
  /** Absolute. */
  api?: string;
  resolve: Required<ResolveOptions>;
  server: Required<Pick<ServerOptions, "port" | "host" | "cors">> &
    ServerOptions;
  build: Required<
    Pick<
      BuildOptions,
      | "outDir"
      | "emptyOutDir"
      | "assetsDir"
      | "sourcemap"
      | "minify"
      | "manifest"
      | "drop"
      | "standalone"
      | "precompress"
      | "server"
      | "features"
    >
  > &
    BuildOptions;
  /** Normalized from `boolean | CompileOptions`: `true` becomes `{}`. */
  compile: false | CompileOptions;
}
