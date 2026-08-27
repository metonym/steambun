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
  transformHtml?: (
    html: string,
    ctx: { path: string },
  ) => string | Promise<string>;
  onBuildEnd?: (artifacts: unknown) => void | Promise<void>;
}

export type Plugin = BunPlugin | SteambunHooks;

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
  compile?: boolean;
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
    >
  > &
    BuildOptions;
  envPrefix: string[];
}
