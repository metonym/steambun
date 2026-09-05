import type {
  BunPlugin,
  MinifyObject,
  MinifyOption,
  ResolvedConfig,
} from "../config/types";
import { toBunEnvPattern, toPublicPath } from "../env/loader";
import { createAliasPlugin } from "../util/alias";
import { mergeFeatures } from "../util/features";
import { createViteSuffixPlugin } from "../util/vite-suffix-plugin";

export type BunMinify = boolean | MinifyObject;

let terserWarned = false;

// "terser" is accepted for drop-in Vite configs and warns once; Bun has no
// Terser backend, so it maps onto Bun's own minifier like "esbuild" does.
export function toBunMinify(
  minify: MinifyOption | undefined,
  warn: (msg: string) => void = console.warn,
): BunMinify {
  if (minify === undefined || minify === true || minify === "esbuild") {
    return true;
  }
  if (minify === false) return false;
  if (minify === "terser") {
    if (!terserWarned) {
      terserWarned = true;
      warn(
        '[steambun] build.minify: "terser" is not available. Using Bun\'s minifier.',
      );
    }
    return true;
  }
  return minify;
}

export function shouldMinifyHtml(minify: MinifyOption | undefined): boolean {
  if (minify === false) return false;
  if (
    minify === undefined ||
    minify === true ||
    minify === "esbuild" ||
    minify === "terser"
  ) {
    return true;
  }
  return minify.whitespace === true;
}

export function toBunSourcemap(
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

/** Prepends steambun's own built-in plugins (alias, Vite import suffixes) ahead of the user's. */
export function withBuiltinPlugins(
  config: ResolvedConfig,
  plugins: BunPlugin[],
): BunPlugin[] {
  const builtins: BunPlugin[] = [];
  const alias = config.resolve?.alias;
  if (alias && Object.keys(alias).length > 0) {
    builtins.push(createAliasPlugin(alias, config.root));
  }
  if (config.resolve?.viteSuffixes) {
    builtins.push(createViteSuffixPlugin());
  }
  return [...builtins, ...plugins];
}

// bun-types 1.4.1 doesn't declare `cssChunking` on BuildConfig yet, though
// Bun.build() accepts it at runtime (verified with a probe build).
type HtmlBuildConfig = Bun.BuildConfig & { cssChunking?: boolean };

export function createHtmlBuildConfig(
  input: HtmlBuildConfigInput,
): HtmlBuildConfig {
  const { config, entrypoints, define, plugins, outDir } = input;
  const standalone = config.build.standalone;
  const publicPath = toPublicPath(config.base);
  const env = toBunEnvPattern(config.envPrefix);
  const features = mergeFeatures(
    config.features,
    process.env.STEAMBUN_FEATURES,
  );
  return {
    entrypoints,
    outdir: outDir,
    root: config.root,
    define,
    plugins: withBuiltinPlugins(config, plugins),
    minify: toBunMinify(config.build.minify),
    drop: config.build.drop,
    sourcemap: toBunSourcemap(config.build.sourcemap),
    ...(publicPath ? { publicPath } : {}),
    ...(env ? { env } : {}),
    ...(features.length > 0 ? { features } : {}),
    ...(standalone
      ? { compile: true }
      : {
          naming: {
            // Entrypoints are always the HTML files themselves — keep their name
            // stable (Vite convention: dist/index.html, not dist/index-<hash>.html).
            entry: "[dir]/[name].[ext]",
            chunk: `${config.build.assetsDir}/[name]-[hash].[ext]`,
            asset: `${config.build.assetsDir}/[name]-[hash].[ext]`,
          },
          ...(config.build.splitting ? { splitting: true } : {}),
          ...(config.build.splitting && config.build.minChunkSize !== undefined
            ? { minChunkSize: config.build.minChunkSize }
            : {}),
          ...(config.build.cssChunking !== undefined
            ? { cssChunking: config.build.cssChunking }
            : {}),
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
  /** One of `Bun.Build.CompileTarget`, e.g. `"bun-linux-x64"`. Omit for the host platform. */
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
  const env = toBunEnvPattern(config.envPrefix);
  const features = mergeFeatures(
    config.features,
    process.env.STEAMBUN_FEATURES,
  );
  const compileOptions = config.compile || {};
  return {
    entrypoints: [prodServePath],
    define,
    plugins: withBuiltinPlugins(config, plugins),
    minify: toBunMinify(config.build.minify),
    drop: config.build.drop,
    target: "bun",
    compile: {
      outfile,
      assets,
      // A compiled server should get its config from real env vars, not
      // files that may not ship with the binary — Bun defaults this true.
      autoloadDotenv: compileOptions.autoloadDotenv ?? false,
      ...(compileOptions.autoloadBunfig !== undefined
        ? { autoloadBunfig: compileOptions.autoloadBunfig }
        : {}),
      ...(compileOptions.windows ? { windows: compileOptions.windows } : {}),
      ...(compileTarget
        ? { target: compileTarget as Bun.Build.CompileTarget }
        : {}),
    },
    ...(env ? { env } : {}),
    ...(config.build.bytecode ? { bytecode: true } : {}),
    ...(features.length > 0 ? { features } : {}),
  };
}
