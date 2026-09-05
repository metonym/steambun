import { existsSync } from "node:fs";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { loadBunfigPlugins } from "../config/bunfig";
import { loadConfig } from "../config/loader";
import type { BunPlugin, ResolvedConfig } from "../config/types";
import { discoverHtmlEntries, discoverSkipDirs } from "../dev/discover";
import {
  buildBundleDefine,
  filterPublicEnv,
  loadEnvFiles,
  withProcessEnv,
} from "../env/loader";
import { writeEnvDts } from "../env/types";
import { writeRoutesDts } from "../routes-dts";
import { buildFileType, formatSize } from "../util/format";
import { splitPlugins } from "../util/plugins";
import { analyzeMetafile, checkBudgets } from "./analyze";
import { writeDistServer } from "./dist-server";
import { minifyHtml } from "./html-minify";
import { applyImportMap } from "./import-map";
import { buildManifest } from "./manifest";
import {
  createCompiledBuildConfig,
  createHtmlBuildConfig,
  shouldMinifyHtml,
} from "./options";
import { precompressDir } from "./precompress";
import { generateProdServeSource } from "./prod-server";
import type { RenameMap } from "./rename";
import { mergeRenames, renameArtifacts, renameMetafileOutputs } from "./rename";
import { applySri, buildCspString, collectInlineHashes } from "./security";

export interface BuildOptions {
  root?: string;
  mode?: string;
  configFile?: string;
}

const BUILD_FILE_TYPE_RANK: Record<string, number> = { html: 0, css: 1, js: 2 };

/** html, then css, then js (unrecognized extensions last); ascending by size within each. */
async function printBuildSummary(
  outDir: string,
  outputs: Array<{ kind: Bun.BuildArtifact["kind"]; path: string }>,
): Promise<void> {
  const rows: { name: string; size: number }[] = [];
  for (const artifact of outputs) {
    if (artifact.kind === "sourcemap") continue;
    const { size } = await stat(artifact.path);
    rows.push({ name: relative(outDir, artifact.path), size });
  }
  rows.sort((a, b) => {
    const rankA = BUILD_FILE_TYPE_RANK[buildFileType(a.name) ?? ""] ?? 3;
    const rankB = BUILD_FILE_TYPE_RANK[buildFileType(b.name) ?? ""] ?? 3;
    return rankA - rankB || a.size - b.size;
  });

  const nameWidth = Math.max(0, ...rows.map((row) => row.name.length));
  const sizes = rows.map((row) => formatSize(row.size));
  const sizeWidth = Math.max(0, ...sizes.map((s) => s.length));

  rows.forEach((row, i) => {
    const name = row.name.padEnd(nameWidth);
    const size = sizes[i]!.padStart(sizeWidth);
    console.log(`  ${name}  ${size}`);
  });
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

  const htmlEntries = await discoverHtmlEntries(config.root, {
    skipDirs: discoverSkipDirs(config),
  });
  if (htmlEntries.length === 0) {
    throw new Error(
      `[steambun] No HTML entrypoints found in ${config.root}. Expected an index.html at the project root.`,
    );
  }

  await writeRoutesDts(config.root, config.api, htmlEntries, config.appType);

  const envDir = config.envDir ?? config.root;
  const fileEnv = await loadEnvFiles(mode, envDir);
  const publicEnv = filterPublicEnv(withProcessEnv(fileEnv), config.envPrefix);
  await writeEnvDts(config.root, filterPublicEnv(fileEnv, config.envPrefix));
  const define = buildBundleDefine(
    publicEnv,
    {
      mode,
      command: "build",
      base: config.base,
    },
    config.define,
  );

  const outDir = join(config.root, config.build.outDir);
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

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("[steambun] Build failed.");
  }

  if (result.metafile) {
    const serveDir = join(config.root, ".steambun");
    await mkdir(serveDir, { recursive: true });
    await writeFile(
      join(serveDir, "metafile.json"),
      JSON.stringify(result.metafile),
      "utf8",
    );
  }

  if (config.build.budgets && result.metafile) {
    const { outputs } = analyzeMetafile(result.metafile);
    const violations = checkBudgets(outputs, config.build.budgets);
    if (violations.length > 0) {
      for (const v of violations) {
        console.error(
          `[steambun] ${v.path} is ${formatSize(v.bytes)}, exceeds budget ${formatSize(v.limit)} for "${v.glob}"`,
        );
      }
      throw new Error("[steambun] Size budget exceeded.");
    }
  }

  let renames: RenameMap = new Map();

  if (config.build.importMap && !config.build.standalone && result.metafile) {
    if (!config.build.splitting) {
      console.warn(
        "[steambun] build.importMap requires build.splitting; skipping.",
      );
    } else {
      const base = config.base.endsWith("/") ? config.base : `${config.base}/`;
      const r = await applyImportMap({
        outDir,
        base,
        metafile: result.metafile,
        htmlFiles: result.outputs
          .filter((a) => a.path.endsWith(".html"))
          .map((a) => a.path),
      });
      renames = mergeRenames(renames, r.renames);
      console.log(
        `[steambun] import map: ${r.renames.size} chunks keyed by content-independent ids`,
      );
    }
  }

  let metafile = result.metafile;
  if (renames.size > 0 && metafile) {
    metafile = renameMetafileOutputs(metafile, renames);
    await writeFile(
      join(config.root, ".steambun", "metafile.json"),
      JSON.stringify(metafile),
      "utf8",
    );
  }

  const transformHtmlHooks = hooks.filter((h) => h.transformHtml);
  const compactHtml = shouldMinifyHtml(config.build.minify);
  const cspHashes = { script: new Set<string>(), style: new Set<string>() };
  if (
    transformHtmlHooks.length > 0 ||
    compactHtml ||
    config.build.sri ||
    config.build.csp
  ) {
    for (const artifact of result.outputs) {
      if (!artifact.path.endsWith(".html")) continue;
      let html = await readFile(artifact.path, "utf8");
      for (const hook of transformHtmlHooks) {
        if (!hook.transformHtml) continue;
        html = await hook.transformHtml(html, { path: artifact.path });
      }
      if (compactHtml) html = minifyHtml(html);
      if (config.build.sri) {
        html = await applySri(html, outDir, dirname(artifact.path));
      }
      if (config.build.csp) {
        const hashes = await collectInlineHashes(html);
        for (const h of hashes.script) cspHashes.script.add(h);
        for (const h of hashes.style) cspHashes.style.add(h);
      }
      await writeFile(artifact.path, html, "utf8");
    }
  }

  if (config.build.csp) {
    const cspString = buildCspString(config.build.csp, {
      script: [...cspHashes.script],
      style: [...cspHashes.style],
    });
    await writeFile(
      join(outDir, "_headers.json"),
      JSON.stringify(
        { "/*.html": { "Content-Security-Policy": cspString } },
        null,
        2,
      ),
      "utf8",
    );
  }

  if (config.publicDir && existsSync(config.publicDir)) {
    await cp(config.publicDir, outDir, { recursive: true });
  }

  if (config.build.precompress) {
    const precompressed = await precompressDir(
      outDir,
      config.build.precompress,
      config.build.precompressMinSize,
    );
    if (precompressed.length > 0) {
      const encodings = [...new Set(precompressed.map((p) => p.encoding))];
      console.log(
        `[steambun] precompressed ${precompressed.length} file${precompressed.length === 1 ? "" : "s"} (${encodings.join(", ")})`,
      );
    }
  }

  if (config.build.manifest && !config.build.standalone && metafile) {
    const manifest = buildManifest(metafile);
    await writeFile(
      join(outDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
  }

  if (config.build.server && !config.build.standalone) {
    await writeDistServer(config, define, bunPlugins, outDir);
  }

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
    await buildCompiled(config, define, bunPlugins, outDir);
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
): Promise<void> {
  const serveDir = join(config.root, ".steambun");
  await mkdir(serveDir, { recursive: true });
  const prodServePath = join(serveDir, "prod-serve.ts");
  await writeFile(
    prodServePath,
    generateProdServeSource(config, outDir),
    "utf8",
  );

  const assets = [outDir];
  if (config.api) assets.push(config.api);

  const compileOptions = config.compile || {};
  const targets = compileOptions.targets ?? [undefined];
  const binOutDir = join(config.root, compileOptions.outDir ?? "bin");

  for (const target of targets) {
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

    if (!result.success) {
      for (const log of result.logs) console.error(log);
      throw new Error(
        `[steambun] Compiled build failed${target ? ` for ${target}` : ""}.`,
      );
    }

    console.log(
      `[steambun] compiled binary: ${relative(config.root, outfile)}`,
    );
  }
}
