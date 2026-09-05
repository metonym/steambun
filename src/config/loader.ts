import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  bunfigToUserConfig,
  isTomlConfigPath,
  projectBunfigPath,
  readBunfigFile,
  resolveBunfigModules,
} from "./bunfig";
import type {
  Command,
  Mode,
  ResolvedConfig,
  UserConfig,
  UserConfigExport,
} from "./types";

const STEAMBUN_CONFIG_NAMES = [
  "steambun.config.ts",
  "steambun.config.mts",
  "steambun.config.js",
  "steambun.config.mjs",
];

export type ConfigKind = "steambun" | "bunfig";

export interface FindConfigResult {
  path: string;
  kind: ConfigKind;
}

export function findConfigFile(root: string): FindConfigResult | null {
  for (const name of STEAMBUN_CONFIG_NAMES) {
    const path = join(root, name);
    if (existsSync(path)) return { path, kind: "steambun" };
  }
  const bunfig = projectBunfigPath(root);
  if (existsSync(bunfig)) return { path: bunfig, kind: "bunfig" };
  return null;
}

async function loadConfigExport(path: string): Promise<UserConfigExport> {
  // Cache-bust so repeated CLI invocations in the same process (tests, watch
  // mode restarts) pick up edits rather than a stale module cache entry.
  const mod = await import(`${path}?t=${Date.now()}`);
  const exported: UserConfigExport = mod.default ?? {};
  return exported;
}

export interface LoadConfigOptions {
  root?: string;
  command: Command;
  mode: Mode;
  configFile?: string;
}

/**
 * Finds, loads, and resolves `steambun.config.ts` (or a legacy `bunfig.toml`)
 * into a fully-defaulted config. Used by the CLI, and by any tooling that
 * needs the same resolved config outside of `dev`/`build`.
 *
 * @example
 * ```ts
 * import { loadConfig } from "steambun";
 *
 * const config = await loadConfig({ command: "build", mode: "production" });
 * console.log(config.build.outDir); // "dist" unless overridden
 * ```
 */
export async function loadConfig(
  opts: LoadConfigOptions,
): Promise<ResolvedConfig> {
  const root = opts.root ? resolveRoot(opts.root) : process.cwd();

  let found: FindConfigResult | null = null;
  if (opts.configFile) {
    const path = isAbsolute(opts.configFile)
      ? opts.configFile
      : join(root, opts.configFile);
    if (!existsSync(path)) {
      throw new Error(`Config file not found: ${path}`);
    }
    found = {
      path,
      kind: isTomlConfigPath(path) ? "bunfig" : "steambun",
    };
  } else {
    found = findConfigFile(root);
  }

  let userConfig: UserConfig = {};
  if (found?.kind === "bunfig") {
    const raw = await readBunfigFile(found.path);
    if (!raw) {
      throw new Error(`[steambun] Failed to load config at ${found.path}`);
    }
    userConfig = bunfigToUserConfig(raw);
    userConfig = await resolveBunfigModules(userConfig, raw, root);
  } else if (found) {
    let exported: UserConfigExport;
    try {
      exported = await loadConfigExport(found.path);
    } catch (err) {
      throw new Error(
        `[steambun] Failed to load config at ${found.path}: ${(err as Error).message}`,
      );
    }
    const resolved =
      typeof exported === "function"
        ? await exported({ command: opts.command, mode: opts.mode })
        : exported;
    userConfig = (resolved as UserConfig) ?? {};
  }

  return resolveDefaults(userConfig, {
    root,
    command: opts.command,
    mode: opts.mode,
    configFile: found?.path ?? null,
  });
}

function resolveRoot(root: string): string {
  return isAbsolute(root) ? root : join(process.cwd(), root);
}

// Exported for the generated prod-serve script (preview/--compile), which
// statically imports the user's config instead of loadConfig's dynamic
// import(path) — a compiled binary can't resolve an external path at runtime.
export function resolveDefaults(
  userConfig: UserConfig,
  ctx: {
    root: string;
    command: Command;
    mode: Mode;
    configFile: string | null;
  },
): ResolvedConfig {
  const publicDir =
    userConfig.publicDir === false
      ? false
      : join(ctx.root, userConfig.publicDir ?? "public");

  const api = userConfig.api ? join(ctx.root, userConfig.api) : undefined;

  const envPrefix = userConfig.envPrefix
    ? Array.isArray(userConfig.envPrefix)
      ? userConfig.envPrefix
      : [userConfig.envPrefix]
    : ["VITE_", "PUBLIC_"];

  return {
    ...userConfig,
    root: ctx.root,
    base: userConfig.base ?? "/",
    publicDir,
    api,
    appType: userConfig.appType === "mpa" ? "mpa" : "spa",
    mode: ctx.mode,
    command: ctx.command,
    configFile: ctx.configFile,
    envPrefix,
    server: {
      port: 5173,
      host: false,
      cors: false,
      ...userConfig.server,
    },
    build: {
      outDir: "dist",
      assetsDir: "assets",
      sourcemap: false,
      minify: true,
      manifest: false,
      standalone: false,
      precompress: false,
      precompressMinSize: 1024,
      server: true,
      ...userConfig.build,
      drop:
        userConfig.build?.drop ??
        (ctx.mode === "production" ? ["debugger"] : []),
    },
  };
}
