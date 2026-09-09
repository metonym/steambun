import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isSteambunHooks } from "../util/plugins";
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
import { viteConfigToUserConfig } from "./vite";

const STEAMBUN_CONFIG_NAMES = [
  "steambun.config.ts",
  "steambun.config.mts",
  "steambun.config.js",
  "steambun.config.mjs",
];

export const VITE_CONFIG_NAMES = [
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
];

export type ConfigKind = "steambun" | "bunfig" | "vite";

export interface FindConfigResult {
  path: string;
  kind: ConfigKind;
}

export function findConfigFile(root: string): FindConfigResult | null {
  for (const name of STEAMBUN_CONFIG_NAMES) {
    const path = join(root, name);
    if (existsSync(path)) return { path, kind: "steambun" };
  }
  for (const name of VITE_CONFIG_NAMES) {
    const path = join(root, name);
    if (existsSync(path)) return { path, kind: "vite" };
  }
  const bunfig = projectBunfigPath(root);
  if (existsSync(bunfig)) return { path: bunfig, kind: "bunfig" };
  return null;
}

// Bumped by dev() before each restart so an edited config is picked up
// instead of a stale module cache entry — never by build/doctor/analyze/
// routes/migrate, which each import their config exactly once per process,
// so generation 0's plain (uncachebusted) import is all they ever need.
// Cache-busting unconditionally (the previous `?t=${Date.now()}`) leaked one
// module instance into the long-lived dev parent's heap per restart.
let configGeneration = 0;

export function bumpConfigGeneration(): void {
  configGeneration++;
}

// Shared by steambun.config.* and vite.config.* — both export either a
// plain object or a `(env) => config` function, per each tool's own
// `defineConfig` convention. Exported for `steambun migrate`, which loads a
// vite.config.* the same way before converting it.
export async function loadRawConfigExport(
  path: string,
  opts: Pick<LoadConfigOptions, "command" | "mode">,
): Promise<unknown> {
  let exported: UserConfigExport;
  try {
    const specifier =
      configGeneration === 0 ? path : `${path}?g=${configGeneration}`;
    const mod = await import(specifier);
    exported = mod.default ?? {};
  } catch (err) {
    throw new Error(
      `[steambun] Failed to load config at ${path}: ${(err as Error).message}`,
    );
  }
  return typeof exported === "function"
    ? await exported({ command: opts.command, mode: opts.mode })
    : exported;
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
  const root = opts.root
    ? isAbsolute(opts.root)
      ? opts.root
      : join(process.cwd(), opts.root)
    : process.cwd();

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
  } else if (found?.kind === "vite") {
    const resolved = await loadRawConfigExport(found.path, opts);
    userConfig = viteConfigToUserConfig(
      (resolved as Record<string, unknown>) ?? {},
      (msg) => console.warn(msg),
    );
  } else if (found) {
    userConfig =
      ((await loadRawConfigExport(found.path, opts)) as UserConfig) ?? {};
  }

  const config = resolveDefaults(userConfig, {
    root,
    command: opts.command,
    mode: opts.mode,
    configFile: found?.path ?? null,
  });

  for (const plugin of config.plugins ?? []) {
    if (isSteambunHooks(plugin) && plugin.configResolved) {
      await plugin.configResolved(config);
    }
  }

  return config;
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

  const envDir = userConfig.envDir
    ? join(ctx.root, userConfig.envDir)
    : ctx.root;

  let appType: "spa" | "mpa";
  if (userConfig.appType === undefined || userConfig.appType === "spa") {
    appType = "spa";
  } else if (userConfig.appType === "mpa") {
    appType = "mpa";
  } else {
    console.warn(
      `[steambun] appType "${userConfig.appType}" is not "spa" or "mpa" — using "spa".`,
    );
    appType = "spa";
  }

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
    envDir,
    appType,
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
      emptyOutDir: true,
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
    compile:
      userConfig.compile === true
        ? {}
        : userConfig.compile === false
          ? false
          : userConfig.compile,
  };
}
