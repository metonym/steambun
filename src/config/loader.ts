import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseSize } from "../build/analyze";
import { isInside, resolveFrom } from "../util/paths";
import { splitPlugins } from "../util/plugins";
import {
  bunfigToUserConfig,
  isTomlConfigPath,
  parseBunfigToml,
  projectBunfigPath,
  resolveBunfigModules,
} from "./bunfig";
import type { Command, ConfigEnv, ResolvedConfig, UserConfig } from "./types";
import { viteConfigToUserConfig } from "./vite";

const configNames = (tool: string) =>
  ["ts", "mts", "js", "mjs"].map((ext) => `${tool}.config.${ext}`);

const STEAMBUN_CONFIG_NAMES = configNames("steambun");
const VITE_CONFIG_NAMES = configNames("vite");

type ConfigKind = "steambun" | "bunfig" | "vite";

interface FoundConfig {
  path: string;
  kind: ConfigKind;
}

/** Every config file in `root`, in precedence order: steambun.config.* > bunfig.toml > vite.config.*. */
export function findConfigFiles(root: string): FoundConfig[] {
  const candidates: FoundConfig[] = [
    ...STEAMBUN_CONFIG_NAMES.map((name) => ({
      path: join(root, name),
      kind: "steambun" as const,
    })),
    { path: projectBunfigPath(root), kind: "bunfig" },
    ...VITE_CONFIG_NAMES.map((name) => ({
      path: join(root, name),
      kind: "vite" as const,
    })),
  ];
  return candidates.filter((candidate) => existsSync(candidate.path));
}

export function findConfigFile(root: string): FoundConfig | null {
  return findConfigFiles(root)[0] ?? null;
}

/** Classifies an explicit `--config` path. */
export function configKindOf(path: string): ConfigKind {
  if (isTomlConfigPath(path)) return "bunfig";
  return VITE_CONFIG_NAMES.includes(basename(path)) ? "vite" : "steambun";
}

/** The argument a user config function receives; Vite reports `preview` as `serve`. */
export function toConfigEnv(command: Command, mode: string): ConfigEnv {
  return {
    command: command === "build" ? "build" : "serve",
    mode,
    isPreview: command === "preview",
  };
}

// Only dev() bumps this per restart; cache-busting every import leaked a module instance per restart in the long-lived dev parent.
let configGeneration = 0;

export function bumpConfigGeneration(): void {
  configGeneration++;
}

/** Loads a `steambun.config.*` / `vite.config.*` default export, calling it with `env` if it's a function. */
export async function loadRawConfigExport(
  path: string,
  env: ConfigEnv,
): Promise<Record<string, unknown>> {
  let exported: unknown;
  try {
    const mod = await import(
      configGeneration === 0 ? path : `${path}?g=${configGeneration}`
    );
    exported = mod.default;
  } catch (err) {
    throw new Error(
      `[steambun] Failed to load config at ${path}: ${(err as Error).message}`,
    );
  }
  const resolved =
    typeof exported === "function" ? await exported(env) : await exported;
  return (resolved ?? {}) as Record<string, unknown>;
}

export interface LoadConfigOptions {
  root?: string;
  command: Command;
  mode: string;
  configFile?: string;
}

/** Finds, loads, and resolves the project config (steambun.config.*, vite.config.*, or bunfig.toml) with defaults applied. */
export async function loadConfig(
  opts: LoadConfigOptions,
): Promise<ResolvedConfig> {
  const root = resolve(opts.root ?? ".");

  let found: FoundConfig | null;
  if (opts.configFile) {
    const path = resolve(root, opts.configFile);
    if (!existsSync(path)) {
      throw new Error(`[steambun] Config file not found: ${path}`);
    }
    found = { path, kind: configKindOf(path) };
  } else {
    found = findConfigFile(root);
  }

  let userConfig: UserConfig = {};
  if (found?.kind === "bunfig") {
    const raw = parseBunfigToml(await Bun.file(found.path).text());
    userConfig = await resolveBunfigModules(bunfigToUserConfig(raw), raw, root);
  } else if (found?.kind === "vite") {
    userConfig = viteConfigToUserConfig(
      await loadRawConfigExport(
        found.path,
        toConfigEnv(opts.command, opts.mode),
      ),
    );
  } else if (found) {
    userConfig = (await loadRawConfigExport(
      found.path,
      toConfigEnv(opts.command, opts.mode),
    )) as UserConfig;
  }

  const config = resolveDefaults(userConfig, {
    root,
    command: opts.command,
    mode: opts.mode,
    configFile: found?.path ?? null,
  });

  for (const hook of splitPlugins(config.plugins).hooks) {
    await hook.configResolved?.(config);
  }

  return config;
}

// Unlike a spread, an explicit `undefined` (e.g. `port: process.env.PORT && Number(process.env.PORT)`) falls back to the default.
function withDefaults<T extends object>(
  defaults: Partial<T>,
  user: Partial<T> | undefined,
): T {
  const out: Record<string, unknown> = { ...user };
  for (const [key, value] of Object.entries(defaults)) out[key] ??= value;
  return out as T;
}

function invalid(what: string, expected: string, got: unknown): Error {
  return new Error(
    `[steambun] ${what} must be ${expected}, got ${JSON.stringify(got)}`,
  );
}

function normalizeEnvPrefix(envPrefix: string | string[] | undefined) {
  if (envPrefix === undefined) return ["VITE_", "PUBLIC_"];
  const prefixes = Array.isArray(envPrefix) ? envPrefix : [envPrefix];
  for (const prefix of prefixes) {
    if (typeof prefix !== "string" || prefix === "") {
      throw invalid("envPrefix", "a non-empty string or array of them", prefix);
    }
  }
  return prefixes;
}

function checkBudgets(budgets: Record<string, string | number> | undefined) {
  for (const [glob, size] of Object.entries(budgets ?? {})) {
    const bytes = parseSize(size);
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw invalid(`build.budgets["${glob}"]`, "a non-negative size", size);
    }
  }
}

// `build()` copies `publicDir` into `outDir` and empties `outDir`, so any overlap is destructive or recursive.
function checkOutDir(
  outDir: string,
  root: string,
  publicDir: string | false,
  api: string | undefined,
): void {
  if (outDir === root) {
    throw new Error("[steambun] build.outDir must not be the project root.");
  }
  if (publicDir && (outDir === publicDir || isInside(publicDir, outDir))) {
    throw new Error(
      `[steambun] build.outDir (${outDir}) must not be inside publicDir (${publicDir}).`,
    );
  }
  for (const [key, dir] of [
    ["publicDir", publicDir],
    ["api", api],
  ] as const) {
    if (dir && isInside(outDir, dir)) {
      throw new Error(
        `[steambun] build.outDir (${outDir}) must not contain ${key} (${dir}); emptying it would delete ${key}.`,
      );
    }
  }
}

// Exported for the generated prod server, which statically imports the config: a compiled binary can't resolve an external path at runtime.
export function resolveDefaults(
  userConfig: UserConfig,
  ctx: {
    root: string;
    command: Command;
    mode: string;
    configFile: string | null;
  },
): ResolvedConfig {
  const publicDir =
    userConfig.publicDir === false
      ? false
      : resolveFrom(ctx.root, userConfig.publicDir ?? "public");

  const api = userConfig.api
    ? resolveFrom(ctx.root, userConfig.api)
    : undefined;

  const envDir = userConfig.envDir
    ? resolveFrom(ctx.root, userConfig.envDir)
    : ctx.root;

  const appType = userConfig.appType ?? "spa";
  if (appType !== "spa" && appType !== "mpa") {
    throw invalid("appType", '"spa" or "mpa"', appType);
  }

  const server = withDefaults<ResolvedConfig["server"]>(
    { port: 5173, host: false, cors: false },
    userConfig.server,
  );
  if (
    !Number.isInteger(server.port) ||
    server.port < 0 ||
    server.port > 65535
  ) {
    throw invalid("server.port", "an integer between 0 and 65535", server.port);
  }
  const maxBody = server.maxRequestBodySize;
  if (maxBody !== undefined && !(Number.isInteger(maxBody) && maxBody > 0)) {
    throw invalid("server.maxRequestBodySize", "a positive integer", maxBody);
  }

  checkBudgets(userConfig.build?.budgets);

  const build = withDefaults<ResolvedConfig["build"]>(
    {
      outDir: "dist",
      emptyOutDir: true,
      assetsDir: "assets",
      sourcemap: false,
      minify: true,
      manifest: false,
      standalone: false,
      precompress: false,
      server: true,
      features: [],
      drop: ctx.mode === "production" ? ["debugger"] : [],
    },
    userConfig.build,
  );
  checkOutDir(resolveFrom(ctx.root, build.outDir), ctx.root, publicDir, api);

  return {
    root: ctx.root,
    base: userConfig.base ?? "/",
    publicDir,
    api,
    envDir,
    appType,
    mode: ctx.mode,
    command: ctx.command,
    configFile: ctx.configFile,
    plugins: userConfig.plugins ?? [],
    middleware: userConfig.middleware ?? [],
    define: userConfig.define ?? {},
    envPrefix: normalizeEnvPrefix(userConfig.envPrefix),
    envSchema: userConfig.envSchema,
    resolve: { alias: userConfig.resolve?.alias ?? {} },
    server,
    build,
    compile: userConfig.compile === true ? {} : (userConfig.compile ?? false),
  };
}
