import { existsSync } from "node:fs";
import { cp, rm, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { loadBunfigPlugins } from "../config/bunfig";
import { loadConfig } from "../config/loader";
import type { ResolvedConfig, SteambunHooks } from "../config/types";
import { discoverConfigHtmlEntries } from "../dev/discover";
import {
  buildBundleDefine,
  filterPublicEnv,
  loadEnvFiles,
  withProcessEnv,
} from "../env/loader";
import { envSchemaTypes, publicOutput, validateEnv } from "../env/schema";
import { writeEnvDts } from "../env/types";
import { writeRoutesDts } from "../routes-dts";
import { buildFileType, formatSize } from "../util/format";
import {
  DIST_SERVER_FILE,
  isInside,
  resolveFrom,
  STEAMBUN_DIR_NAME,
} from "../util/paths";
import { splitPlugins } from "../util/plugins";
import { log } from "../util/terminal";
import { analyzeMetafile, checkBudgets, refreshOutputSizes } from "./analyze";
import { buildCompiled } from "./compile";
import { writeDistServer } from "./dist-server";
import { minifyHtml, shouldMinifyHtml } from "./html-minify";
import { buildManifest } from "./manifest";
import { assertBuildSuccess, createHtmlBuildConfig } from "./options";
import { precompressDir } from "./precompress";
import { printBuildSummary } from "./summary";

export interface BuildOptions {
  root?: string;
  mode?: string;
  configFile?: string;
  emptyOutDir?: boolean;
}

/** Empties `outDir` before a rebuild, but only when it is inside `root`. */
async function emptyOutDirIfInsideRoot(
  config: ResolvedConfig,
  outDir: string,
): Promise<void> {
  if (!config.build.emptyOutDir || !existsSync(outDir)) return;
  if (isInside(config.root, outDir)) {
    await rm(outDir, { recursive: true, force: true });
    return;
  }
  const message = `[steambun] build.outDir "${relative(config.root, outDir)}" is outside root — not emptying it (set build.emptyOutDir: false to silence)`;
  log.warn(message);
}

/** One read/write per HTML output: `transformHtml` hooks, then whitespace minification. */
async function rewriteHtml(
  config: ResolvedConfig,
  hooks: SteambunHooks[],
  htmlFiles: string[],
): Promise<void> {
  const transforms = hooks.filter((h) => h.transformHtml);
  const minify = shouldMinifyHtml(config.build.minify);
  if (transforms.length === 0 && !minify) return;

  await Promise.all(
    htmlFiles.map(async (path) => {
      let html = await Bun.file(path).text();
      for (const hook of transforms) {
        html = await hook.transformHtml!(html, { path });
      }
      await Bun.write(path, minify ? minifyHtml(html) : html);
    }),
  );
}

/**
 * Replaces the metafile's byte counts with on-disk sizes (HTML was rewritten
 * after bundling), enforces `build.budgets` against those, and persists it
 * for `steambun analyze`.
 */
async function finalizeMetafile(
  config: ResolvedConfig,
  metafileIn: Bun.BuildMetafile,
  outDir: string,
): Promise<Bun.BuildMetafile> {
  const metafile = await refreshOutputSizes(metafileIn, outDir);

  if (config.build.budgets) {
    const violations = checkBudgets(
      analyzeMetafile(metafile).outputs,
      config.build.budgets,
    );
    for (const v of violations) {
      const message = `${v.path} is ${formatSize(v.bytes)}, exceeds budget ${formatSize(v.limit)} for "${v.glob}"`;
      log.error(`[steambun] build.budgets: ${message}`);
    }
    if (violations.length > 0)
      throw new Error("[steambun] build.budgets: size budget exceeded.");
  }

  await Bun.write(
    join(config.root, STEAMBUN_DIR_NAME, "metafile.json"),
    JSON.stringify(metafile),
  );
  return metafile;
}

/** Runs on failure too; then a throwing hook is logged rather than masking the build error. */
async function closeBundle(
  hooks: SteambunHooks[],
  outDir: string,
  succeeded: boolean,
): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook.closeBundle?.({ outDir });
    } catch (error) {
      if (succeeded) throw error;
      log.error(
        `[steambun] closeBundle hook failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}

export async function build(opts: BuildOptions = {}): Promise<void> {
  const startedAt = performance.now();
  const mode = opts.mode ?? "production";
  const config = await loadConfig({
    root: opts.root,
    command: "build",
    mode,
    configFile: opts.configFile,
  });
  if (opts.emptyOutDir !== undefined)
    config.build.emptyOutDir = opts.emptyOutDir;

  if (config.build.standalone) {
    for (const key of ["budgets", "manifest"] as const) {
      if (config.build[key]) {
        log.warn(
          `[steambun] build.${key}: ignored with build.standalone (no metafile).`,
        );
      }
    }
  }

  const htmlEntries = await discoverConfigHtmlEntries(config);
  if (htmlEntries.length === 0) {
    throw new Error(
      `[steambun] No HTML entrypoints found in ${config.root}. Expected an index.html at the project root.`,
    );
  }

  await writeRoutesDts(config.root, config.api, htmlEntries, config.appType);

  const fileEnv = await loadEnvFiles(mode, config.envDir);
  const env = withProcessEnv(fileEnv);
  const publicEnv = filterPublicEnv(env, config.envPrefix);
  const typedPublicEnv = publicOutput(
    await validateEnv(config.envSchema, env),
    config.envPrefix,
  );
  await writeEnvDts(
    config.root,
    filterPublicEnv(fileEnv, config.envPrefix),
    envSchemaTypes(config, typedPublicEnv),
  );
  const define = buildBundleDefine(
    publicEnv,
    { mode, command: "build", base: config.base },
    config.define,
    typedPublicEnv,
  );

  const outDir = resolveFrom(config.root, config.build.outDir);
  await emptyOutDirIfInsideRoot(config, outDir);
  // Copied first so bundle output and generated files win on a name clash.
  if (config.publicDir && existsSync(config.publicDir)) {
    const { publicDir } = config;
    // Dotfiles (`.env`, `.DS_Store`, ...) are never served in dev, so they must not be published either.
    await cp(publicDir, outDir, {
      recursive: true,
      filter: (src) => src === publicDir || !basename(src).startsWith("."),
    });
  }

  const { bunPlugins, hooks } = splitPlugins([
    ...(await loadBunfigPlugins(config.root, config.configFile)),
    ...config.plugins,
  ]);

  let serverBuild: Promise<void> | undefined;
  let succeeded = false;
  try {
    const entrypoints = htmlEntries.map((e) => e.file);
    for (const hook of hooks) await hook.buildStart?.({ entrypoints });

    const result = await Bun.build(
      createHtmlBuildConfig({
        config,
        entrypoints,
        define,
        plugins: bunPlugins,
        outDir,
      }),
    );
    assertBuildSuccess(result, "[steambun] Build failed.");

    // Nothing below feeds `dist/server.js`, so bundle it concurrently. The
    // `.catch` only marks the rejection handled; the later `await` still throws.
    serverBuild =
      config.build.server && !config.build.standalone
        ? writeDistServer(config, define, bunPlugins, outDir, publicEnv)
        : undefined;
    serverBuild?.catch(() => {});

    const htmlFiles = result.outputs
      .filter((a) => buildFileType(a.path) === "html")
      .map((a) => a.path);
    await rewriteHtml(config, hooks, htmlFiles);

    const metafile =
      result.metafile &&
      (await finalizeMetafile(config, result.metafile, outDir));

    if (config.build.manifest && metafile) {
      await writeFile(
        join(outDir, "manifest.json"),
        JSON.stringify(buildManifest(metafile), null, 2),
      );
    }

    if (config.build.precompress) {
      const precompressed = await precompressDir(
        outDir,
        config.build.precompress,
        // server.js is executed, never served, and may still be bundling.
        new Set([join(outDir, DIST_SERVER_FILE)]),
      );
      if (precompressed.length > 0) {
        const encodings = new Set(precompressed.map((p) => p.encoding));
        log.info(
          `[steambun] build.precompress: ${precompressed.length} file(s) (${[...encodings].join(", ")})`,
        );
      }
    }

    await serverBuild;

    log.info(`[steambun] build complete: ${relative(config.root, outDir)}/`);
    await printBuildSummary(outDir, result.outputs);

    if (config.compile) {
      await buildCompiled(config, define, bunPlugins, outDir, publicEnv);
    }

    succeeded = true;
  } finally {
    // Bundling `dist/server.js` may still be writing into `outDir`.
    await serverBuild?.catch(() => {});
    await closeBundle(hooks, outDir, succeeded);
  }

  const entryNames = htmlEntries.map((e) => relative(config.root, e.file));
  const elapsed = Math.round(performance.now() - startedAt);
  log.info(`[steambun] built ${entryNames.join(", ")} in ${elapsed}ms`);
}
