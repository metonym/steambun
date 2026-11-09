import type { BunPlugin, ResolvedConfig } from "../config/types";
import { toPublicPath } from "../env/loader";
import { createAliasPlugin } from "../util/alias";
import { mergeFeatures } from "../util/features";
import { createImportGlobPlugin } from "../util/import-glob";
import { createServerBoundaryPlugin } from "../util/server-boundary";
import { log } from "../util/terminal";
import { createViteSuffixPlugin } from "../util/vite-suffix-plugin";

/** Prints Bun's own logs, then throws `message`. */
export function assertBuildSuccess(
  result: Bun.BuildOutput,
  message: string,
): void {
  if (result.success) return;
  for (const entry of result.logs) log.error(String(entry));
  throw new Error(message);
}

function toBunSourcemap(
  sourcemap: ResolvedConfig["build"]["sourcemap"],
): "inline" | "external" | "none" {
  if (sourcemap === true) return "inline";
  return sourcemap || "none";
}

export interface HtmlBuildConfigInput {
  config: ResolvedConfig;
  entrypoints: string[];
  define: Record<string, string>;
  plugins: BunPlugin[];
  outDir: string;
}

/** Prepends the alias and Vite-suffix plugins ahead of the user's. */
export function withBuiltinPlugins(
  config: ResolvedConfig,
  plugins: BunPlugin[],
): BunPlugin[] {
  const alias = config.resolve?.alias;
  const hasAlias = alias && Object.keys(alias).length > 0;
  return [
    ...(hasAlias ? [createAliasPlugin(alias, config.root)] : []),
    createViteSuffixPlugin(alias, config.root),
    ...plugins,
  ];
}

/** Options every bundle (client, `dist/server.js`, compiled binary) shares. */
export function commonBuildOptions(
  config: ResolvedConfig,
  define: Record<string, string>,
) {
  return {
    // Return failures as logs so `assertBuildSuccess` can print them (the default rejects with a bare "Bundle failed").
    throw: false,
    define,
    minify: config.build.minify,
    drop: config.build.drop,
    features: buildFeatures(config),
  };
}

function buildFeatures(config: ResolvedConfig): string[] | undefined {
  const features = mergeFeatures(
    config.build.features,
    process.env.STEAMBUN_FEATURES,
  );
  // `features: []` is not the same as omitting it.
  return features.length > 0 ? features : undefined;
}

function assetNaming(config: ResolvedConfig) {
  return {
    entry: "[dir]/[name].[ext]",
    chunk: `${config.build.assetsDir}/[name]-[hash].[ext]`,
    asset: `${config.build.assetsDir}/[name]-[hash].[ext]`,
  };
}

export function createHtmlBuildConfig(
  input: HtmlBuildConfigInput,
): Bun.BuildConfig {
  const { config, entrypoints, define, plugins, outDir } = input;
  const standalone = config.build.standalone;
  return {
    ...commonBuildOptions(config, define),
    entrypoints,
    outdir: outDir,
    root: config.root,
    // Client-only plugins: the compiled server loads API routes at runtime.
    // The boundary goes first so an alias can't resolve a `.server` import
    // before it's checked; the glob plugin goes last because it claims every
    // project source file.
    plugins: [
      createServerBoundaryPlugin(
        config.root,
        config.api,
        config.resolve?.alias,
      ),
      ...withBuiltinPlugins(config, plugins),
      createImportGlobPlugin(config.root, config.resolve?.alias),
    ],
    sourcemap: toBunSourcemap(config.build.sourcemap),
    publicPath: toPublicPath(config.base),
    ...(standalone
      ? { compile: true }
      : {
          naming: assetNaming(config),
          splitting: config.build.splitting || undefined,
        }),
    metafile: !standalone,
    target: config.build.target ?? "browser",
  };
}

export interface CompiledBuildConfigInput {
  config: ResolvedConfig;
  prodServePath: string;
  define: Record<string, string>;
  plugins: BunPlugin[];
  outfile: string;
  assets: string[];
  /** A `Bun.Build.CompileTarget` such as `"bun-linux-x64"`; omit for the host platform. */
  compileTarget?: string;
}

export function createCompiledBuildConfig(
  input: CompiledBuildConfigInput,
): Bun.BuildConfig {
  const {
    config,
    prodServePath,
    define,
    plugins,
    outfile,
    assets,
    compileTarget,
  } = input;
  const compileOptions = config.compile || {};
  return {
    ...commonBuildOptions(config, define),
    entrypoints: [prodServePath],
    plugins: withBuiltinPlugins(config, plugins),
    target: "bun",
    compile: {
      outfile,
      assets,
      // Bun defaults this true; a binary shouldn't depend on files that may not ship with it.
      autoloadDotenv: compileOptions.autoloadDotenv ?? false,
      // `compile` rejects explicit `undefined` keys, unlike the top-level options.
      ...(compileOptions.autoloadBunfig !== undefined
        ? { autoloadBunfig: compileOptions.autoloadBunfig }
        : {}),
      ...(compileOptions.windows ? { windows: compileOptions.windows } : {}),
      ...(compileTarget
        ? { target: compileTarget as Bun.Build.CompileTarget }
        : {}),
    },
    bytecode: compileOptions.bytecode || undefined,
  };
}
