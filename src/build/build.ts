import { existsSync } from "node:fs";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
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
import { formatSize } from "../util/format";
import { splitPlugins } from "../util/plugins";
import { analyzeMetafile, checkBudgets } from "./analyze";
import { writeDistServer } from "./dist-server";
import { minifyHtml } from "./html-minify";
import { buildManifest } from "./manifest";
import {
  createCompiledBuildConfig,
  createHtmlBuildConfig,
  shouldMinifyHtml,
} from "./options";
import { precompressDir } from "./precompress";
import { generateProdServeSource } from "./prod-server";

export interface BuildOptions {
  root?: string;
  mode?: string;
  configFile?: string;
}

export async function build(opts: BuildOptions = {}): Promise<void> {
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

  const transformHtmlHooks = hooks.filter((h) => h.transformHtml);
  const compactHtml = shouldMinifyHtml(config.build.minify);
  if (transformHtmlHooks.length > 0 || compactHtml) {
    for (const artifact of result.outputs) {
      if (!artifact.path.endsWith(".html")) continue;
      let html = await readFile(artifact.path, "utf8");
      for (const hook of transformHtmlHooks) {
        if (!hook.transformHtml) continue;
        html = await hook.transformHtml(html, { path: artifact.path });
      }
      if (compactHtml) html = minifyHtml(html);
      await writeFile(artifact.path, html, "utf8");
    }
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

  if (config.build.manifest && !config.build.standalone && result.metafile) {
    const manifest = buildManifest(result.metafile);
    await writeFile(
      join(outDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
  }

  if (config.build.server && !config.build.standalone) {
    await writeDistServer(config, define, bunPlugins, outDir);
  }

  console.log(`[steambun] build complete: ${relative(config.root, outDir)}/`);
  for (const artifact of result.outputs) {
    if (artifact.kind === "sourcemap") continue;
    const { size } = await stat(artifact.path);
    console.log(`  ${relative(outDir, artifact.path)}  ${formatSize(size)}`);
  }

  for (const hook of hooks) {
    if (hook.onBuildEnd) await hook.onBuildEnd(result.outputs);
  }

  if (config.compile) {
    await buildCompiled(config, define, bunPlugins, outDir);
  }

  for (const hook of hooks) {
    if (hook.closeBundle) await hook.closeBundle({ outDir });
  }
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

  const binaryName = process.platform === "win32" ? "server.exe" : "server";
  const outfile = join(
    config.root,
    config.build.outDir,
    "..",
    "bin",
    binaryName,
  );

  const result = await Bun.build(
    createCompiledBuildConfig({
      config,
      prodServePath,
      define,
      plugins,
      outfile,
      assets,
    }),
  );

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("[steambun] Compiled build failed.");
  }

  console.log(`[steambun] compiled binary: ${relative(config.root, outfile)}`);
}
