import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { loadBunfigPlugins } from "../config/bunfig";
import { loadConfig } from "../config/loader";
import type { BunPlugin, ResolvedConfig, SteambunHooks } from "../config/types";
import { discoverHtmlEntries, discoverSkipDirs } from "../dev/discover";
import {
  buildBundleDefine,
  filterPublicEnv,
  loadEnvFiles,
  withProcessEnv,
} from "../env/loader";
import { envSchemaTypes, publicOutput, validateEnv } from "../env/schema";
import { writeEnvDts } from "../env/types";
import { writeRoutesDts } from "../routes-dts";
import { ciAnnotation } from "../util/annotations";
import { buildFileType, formatSize } from "../util/format";
import { splitPlugins } from "../util/plugins";
import { analyzeMetafile, checkBudgets } from "./analyze";
import { CPU_CONCURRENCY, mapLimit } from "./concurrency";
import {
  type HeaderRules,
  mergeHeaderRules,
  toNetlifyHeaders,
  toRedirects,
  toVercelJson,
} from "./deploy";
import { DIST_SERVER_FILE, writeDistServer } from "./dist-server";
import { minifyHtml } from "./html-minify";
import { applyImportMap } from "./import-map";
import { buildManifest } from "./manifest";
import {
  assertBuildSuccess,
  createCompiledBuildConfig,
  createHtmlBuildConfig,
  shouldMinifyHtml,
  toBunMinify,
} from "./options";
import { COMPRESSIBLE, compress, precompressDir } from "./precompress";
import { generateProdServeSource } from "./prod-server";
import type { RenameMap } from "./rename";
import {
  mergeRenames,
  refreshOutputSizes,
  renameArtifacts,
  renameMetafileOutputs,
} from "./rename";
import {
  applySri,
  buildCspString,
  collectInlineHashes,
  createSriHasher,
} from "./security";
import { extractSharedCss, type SharedCssResult } from "./shared-css";

/** Inline `<script>`/`<style>` hashes collected across every page, for `build.csp`. */
interface InlineHashSets {
  script: Set<string>;
  style: Set<string>;
}

export interface BuildOptions {
  root?: string;
  mode?: string;
  configFile?: string;
  emptyOutDir?: boolean;
}

const BUILD_FILE_TYPE_RANK: Record<string, number> = { html: 0, css: 1, js: 2 };
const GZIP_MIN_SIZE = 1024;

function shouldGzip(name: string, size: number): boolean {
  return (
    size >= GZIP_MIN_SIZE && COMPRESSIBLE.has(name.slice(name.lastIndexOf(".")))
  );
}

/** html, then css, then js (unrecognized extensions last); ascending by size within each. */
async function printBuildSummary(
  outDir: string,
  outputs: Array<{ kind: Bun.BuildArtifact["kind"]; path: string }>,
): Promise<void> {
  const rows = await Promise.all(
    outputs
      .filter((artifact) => artifact.kind !== "sourcemap")
      .map(async (artifact) => {
        const name = relative(outDir, artifact.path);
        // `build.precompress: ["gzip", ...]` already wrote a level-9 sibling —
        // stat it instead of gzipping the file a second time.
        const [own, sibling] = await Promise.all([
          stat(artifact.path),
          stat(`${artifact.path}.gz`).catch(() => null),
        ]);
        const gzip = sibling
          ? sibling.size
          : shouldGzip(name, own.size)
            ? (await compress(await readFile(artifact.path), "gzip")).length
            : undefined;
        return { name, size: own.size, gzip };
      }),
  );
  rows.sort((a, b) => {
    const rankA = BUILD_FILE_TYPE_RANK[buildFileType(a.name) ?? ""] ?? 3;
    const rankB = BUILD_FILE_TYPE_RANK[buildFileType(b.name) ?? ""] ?? 3;
    return rankA - rankB || a.size - b.size;
  });

  const nameWidth = Math.max(0, ...rows.map((row) => row.name.length));
  const sizes = rows.map((row) => formatSize(row.size));
  const gzipLabels = rows.map((row) =>
    row.gzip === undefined ? "" : `gzip: ${formatSize(row.gzip)}`,
  );
  const sizeWidth = Math.max(0, ...sizes.map((s) => s.length));
  const gzipWidth = Math.max(0, ...gzipLabels.map((s) => s.length));

  rows.forEach((row, i) => {
    const line = `  ${row.name.padEnd(nameWidth)}  ${sizes[i]!.padStart(sizeWidth)}  ${gzipLabels[i]!.padEnd(gzipWidth)}`;
    console.log(line.trimEnd());
  });

  const totalSize = rows.reduce((sum, row) => sum + row.size, 0);
  const totalGzip = rows.reduce((sum, row) => sum + (row.gzip ?? 0), 0);
  const totalLabel = totalGzip > 0 ? `gzip: ${formatSize(totalGzip)}` : "";
  const total = `  ${"total".padEnd(nameWidth)}  ${formatSize(totalSize).padStart(sizeWidth)}  ${totalLabel}`;
  console.log(total.trimEnd());
}

/**
 * Removes `outDir` before a rebuild, but only when it is inside `root` — an
 * `outDir` pointing anywhere else is warned about and left alone.
 */
async function emptyOutDirIfInsideRoot(
  config: ResolvedConfig,
  outDir: string,
): Promise<void> {
  if (!config.build.emptyOutDir || !existsSync(outDir)) return;
  const rel = relative(config.root, outDir);
  if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
    await rm(outDir, { recursive: true, force: true });
    return;
  }
  const message = `[steambun] build.outDir "${rel}" is outside root — not emptying it (set build.emptyOutDir: false to silence)`;
  console.warn(message);
  ciAnnotation("warning", message);
}

/**
 * The two passes that rewrite emitted chunks and rename them: `build.importMap`
 * first (it keys JS chunks by content-independent ids), then `build.sharedCss`
 * (it cuts shared spans out of each page's stylesheet). Both must run before
 * SRI/CSP, which hash the final bytes.
 */
async function rewriteChunks(
  config: ResolvedConfig,
  metafile: Bun.BuildMetafile | undefined,
  outDir: string,
  base: string,
  htmlFiles: string[],
): Promise<{ renames: RenameMap; sharedCss?: SharedCssResult }> {
  let renames: RenameMap = new Map();
  if (config.build.standalone || !metafile) return { renames };

  if (config.build.importMap) {
    if (!config.build.splitting) {
      console.warn(
        "[steambun] build.importMap requires build.splitting; skipping.",
      );
    } else {
      const r = await applyImportMap({ outDir, base, metafile, htmlFiles });
      renames = mergeRenames(renames, r.renames);
      console.log(
        `[steambun] import map: ${r.renames.size} chunks keyed by content-independent ids`,
      );
    }
  }

  if (!config.build.sharedCss) return { renames };

  const minSize =
    typeof config.build.sharedCss === "object"
      ? (config.build.sharedCss.minSize ?? 2048)
      : 2048;
  const sharedCss = await extractSharedCss({
    outDir,
    assetsDir: config.build.assetsDir,
    base,
    metafile,
    minSize,
    minify: toBunMinify(config.build.minify),
    htmlFiles,
  });
  renames = mergeRenames(renames, sharedCss.renames);

  const pageCount = Object.keys(sharedCss.sharedByPage).length;
  console.log(
    `[steambun] shared css: ${sharedCss.sharedFiles.length} file${sharedCss.sharedFiles.length === 1 ? "" : "s"}, saved ${formatSize(sharedCss.savedBytes)} across ${pageCount} page${pageCount === 1 ? "" : "s"}`,
  );
  for (const skip of sharedCss.skipped) {
    console.warn(
      `[steambun] shared css: skipped ${skip.page} (${skip.reason})`,
    );
  }
  return { renames, sharedCss };
}

/**
 * Applies `renames` to the metafile, replaces its byte counts with the sizes
 * actually on disk, enforces `build.budgets` against those, and persists it to
 * `.steambun/metafile.json` for `steambun analyze`.
 */
async function finalizeMetafile(
  config: ResolvedConfig,
  metafileIn: Bun.BuildMetafile | undefined,
  renames: RenameMap,
  outDir: string,
): Promise<Bun.BuildMetafile | undefined> {
  if (!metafileIn) return undefined;
  const renamed =
    renames.size > 0 ? renameMetafileOutputs(metafileIn, renames) : metafileIn;
  const metafile = await refreshOutputSizes(renamed, outDir);

  if (config.build.budgets) {
    const { outputs } = analyzeMetafile(metafile);
    const violations = checkBudgets(outputs, config.build.budgets);
    if (violations.length > 0) {
      for (const v of violations) {
        const message = `${v.path} is ${formatSize(v.bytes)}, exceeds budget ${formatSize(v.limit)} for "${v.glob}"`;
        console.error(`[steambun] ${message}`);
        ciAnnotation("error", message, { file: v.path });
      }
      throw new Error("[steambun] Size budget exceeded.");
    }
  }

  const serveDir = join(config.root, ".steambun");
  await mkdir(serveDir, { recursive: true });
  await writeFile(
    join(serveDir, "metafile.json"),
    JSON.stringify(metafile),
    "utf8",
  );
  return metafile;
}

/**
 * The one read/write per HTML output: `transformHtml` hooks, minification,
 * SRI, and the inline-script/style hashes `build.csp` needs. Returns those
 * hashes merged in `htmlFiles` order.
 */
async function rewriteHtmlOutputs(
  config: ResolvedConfig,
  hooks: SteambunHooks[],
  htmlFiles: string[],
  outDir: string,
  base: string,
): Promise<InlineHashSets> {
  const cspHashes: InlineHashSets = {
    script: new Set<string>(),
    style: new Set<string>(),
  };
  const transformHtmlHooks = hooks.filter((h) => h.transformHtml);
  const compactHtml = shouldMinifyHtml(config.build.minify);
  if (
    transformHtmlHooks.length === 0 &&
    !compactHtml &&
    !config.build.sri &&
    !config.build.csp
  ) {
    return cspHashes;
  }

  // One hasher for the whole build: an asset linked from every page is read
  // and digested once, not once per page.
  const sriHasher = createSriHasher(outDir, base);
  const perPage = await Promise.all(
    htmlFiles.map(async (path) => {
      let html = await readFile(path, "utf8");
      for (const hook of transformHtmlHooks) {
        if (!hook.transformHtml) continue;
        html = await hook.transformHtml(html, { path });
      }
      if (compactHtml) html = minifyHtml(html);
      if (config.build.sri) {
        html = await applySri(
          html,
          outDir,
          dirname(path),
          base,
          console.warn,
          sriHasher,
        );
      }
      const hashes = config.build.csp
        ? await collectInlineHashes(html)
        : undefined;
      await writeFile(path, html, "utf8");
      return hashes;
    }),
  );

  // Merged after the fact, in htmlFiles order, so the CSP header is stable.
  for (const hashes of perPage) {
    if (!hashes) continue;
    for (const h of hashes.script) cspHashes.script.add(h);
    for (const h of hashes.style) cspHashes.style.add(h);
  }
  return cspHashes;
}

/**
 * Writes `_headers.json` (read back by preview/`dist/server.js`) and, for
 * `build.deploy`, the host's own `_headers`/`_redirects`/`vercel.json`.
 */
async function writeHeaderAndDeployFiles(
  config: ResolvedConfig,
  outDir: string,
  cspHashes: InlineHashSets,
): Promise<void> {
  const cspRules: HeaderRules = config.build.csp
    ? {
        "/**/*.html": {
          "Content-Security-Policy": buildCspString(config.build.csp, {
            script: [...cspHashes.script],
            style: [...cspHashes.style],
          }),
        },
      }
    : {};
  const headerRules = mergeHeaderRules(cspRules, config.build.headers ?? {});
  if (Object.keys(headerRules).length > 0) {
    await writeFile(
      join(outDir, "_headers.json"),
      JSON.stringify(headerRules, null, 2),
      "utf8",
    );
  }

  if (!config.build.deploy) return;

  const assetsRule: HeaderRules = {
    [`/${config.build.assetsDir}/*`]: {
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  };
  const deployRules = mergeHeaderRules(assetsRule, headerRules);
  if (config.build.deploy === "vercel") {
    await writeFile(
      join(outDir, "vercel.json"),
      JSON.stringify(toVercelJson(deployRules, config.appType), null, 2),
      "utf8",
    );
  } else {
    await writeFile(
      join(outDir, "_headers"),
      toNetlifyHeaders(deployRules),
      "utf8",
    );
    const redirects = toRedirects(config.appType);
    if (redirects.length > 0) {
      await writeFile(join(outDir, "_redirects"), redirects, "utf8");
    }
  }
  console.log(`[steambun] deploy target: ${config.build.deploy}`);
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

  const { skipDirs, skipPaths } = discoverSkipDirs(config);
  const htmlEntries = await discoverHtmlEntries(config.root, {
    skipDirs,
    skipPaths,
  });
  if (htmlEntries.length === 0) {
    throw new Error(
      `[steambun] No HTML entrypoints found in ${config.root}. Expected an index.html at the project root.`,
    );
  }

  await writeRoutesDts(config.root, config.api, htmlEntries, config.appType);

  const envDir = config.envDir;
  const fileEnv = await loadEnvFiles(mode, envDir);
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
    {
      mode,
      command: "build",
      base: config.base,
    },
    config.define,
    typedPublicEnv,
  );

  const outDir = join(config.root, config.build.outDir);
  await emptyOutDirIfInsideRoot(config, outDir);

  const { bunPlugins, hooks } = splitPlugins([
    ...(await loadBunfigPlugins(config.root)),
    ...(config.plugins ?? []),
  ]);

  const entrypoints = htmlEntries.map((e) => e.file);
  for (const hook of hooks) {
    if (hook.buildStart) await hook.buildStart({ config, entrypoints });
  }

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

  // Nothing below feeds `dist/server.js`, so start it now and let it bundle
  // while the main thread rewrites HTML/CSS. `.catch` only marks the
  // rejection handled; the `await` at the end still throws it.
  const serverBuild =
    config.build.server && !config.build.standalone
      ? writeDistServer(config, define, bunPlugins, outDir, publicEnv)
      : undefined;
  serverBuild?.catch(() => {});

  const base = config.base.endsWith("/") ? config.base : `${config.base}/`;
  const htmlFiles = result.outputs
    .filter((a) => a.path.endsWith(".html"))
    .map((a) => a.path);

  const { renames, sharedCss } = await rewriteChunks(
    config,
    result.metafile,
    outDir,
    base,
    htmlFiles,
  );
  const metafile = await finalizeMetafile(
    config,
    result.metafile,
    renames,
    outDir,
  );

  const cspHashes = await rewriteHtmlOutputs(
    config,
    hooks,
    htmlFiles,
    outDir,
    base,
  );
  await writeHeaderAndDeployFiles(config, outDir, cspHashes);

  if (config.publicDir && existsSync(config.publicDir)) {
    await cp(config.publicDir, outDir, { recursive: true });
  }

  if (config.build.precompress) {
    const precompressed = await precompressDir(
      outDir,
      config.build.precompress,
      config.build.precompressMinSize,
      // server.js is executed, never served, and may still be bundling.
      new Set([join(outDir, DIST_SERVER_FILE)]),
    );
    if (precompressed.length > 0) {
      const encodings = [...new Set(precompressed.map((p) => p.encoding))];
      console.log(
        `[steambun] precompressed ${precompressed.length} file${precompressed.length === 1 ? "" : "s"} (${encodings.join(", ")})`,
      );
    }
  }

  if (config.build.manifest && !config.build.standalone && metafile) {
    const manifest = buildManifest(metafile, sharedCss?.sharedByPage);
    await writeFile(
      join(outDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
  }

  await serverBuild;

  const summaryOutputs =
    renames.size > 0
      ? renameArtifacts(result.outputs, renames, outDir)
      : result.outputs;

  console.log(`[steambun] build complete: ${relative(config.root, outDir)}/`);
  await printBuildSummary(outDir, summaryOutputs);

  for (const hook of hooks) {
    if (hook.onBuildEnd) await hook.onBuildEnd(summaryOutputs);
  }

  if (config.compile) {
    await buildCompiled(config, define, bunPlugins, outDir, publicEnv);
  }

  for (const hook of hooks) {
    if (hook.closeBundle) await hook.closeBundle({ outDir });
  }

  const entryNames = htmlEntries.map((e) => relative(config.root, e.file));
  const elapsed = Math.round(performance.now() - startedAt);
  console.log(`[steambun] built ${entryNames.join(", ")} in ${elapsed}ms`);
}

async function buildCompiled(
  config: ResolvedConfig,
  define: Record<string, string>,
  plugins: BunPlugin[],
  outDir: string,
  publicEnv: Record<string, string>,
): Promise<void> {
  const serveDir = join(config.root, ".steambun");
  await mkdir(serveDir, { recursive: true });
  const prodServePath = join(serveDir, "prod-serve.ts");
  await writeFile(
    prodServePath,
    generateProdServeSource(config, outDir, { envCheck: publicEnv }),
    "utf8",
  );

  const assets = [outDir];
  if (config.api) assets.push(config.api);

  const compileOptions = config.compile || {};
  const targets = compileOptions.targets ?? [undefined];
  const binOutDir = join(config.root, compileOptions.outDir ?? "bin");

  // Each compile is CPU-heavy and writes its own outfile, so they overlap,
  // bounded to half the cores. Logging happens afterwards, in target order.
  const outfiles = await mapLimit(
    targets,
    Math.max(1, Math.floor(CPU_CONCURRENCY / 2)),
    async (target) => {
      const isWindows = target
        ? target.startsWith("bun-windows-")
        : process.platform === "win32";
      const suffix = isWindows ? ".exe" : "";
      const name = target ? `server-${target}${suffix}` : `server${suffix}`;
      const outfile = join(binOutDir, name);

      const result = await Bun.build(
        createCompiledBuildConfig({
          config,
          prodServePath,
          define,
          plugins,
          outfile,
          assets,
          compileTarget: target,
        }),
      );

      assertBuildSuccess(
        result,
        `[steambun] Compiled build failed${target ? ` for ${target}` : ""}.`,
      );
      return outfile;
    },
  );

  for (const outfile of outfiles) {
    console.log(
      `[steambun] compiled binary: ${relative(config.root, outfile)}`,
    );
  }
}
