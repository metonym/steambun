import { join, relative } from "node:path";
import type { BunPlugin, ResolvedConfig } from "../config/types";
import { log } from "../util/terminal";
import { CPU_CONCURRENCY, mapLimit } from "./concurrency";
import { assertBuildSuccess, createCompiledBuildConfig } from "./options";
import { writeProdServe } from "./prod-server";

export async function buildCompiled(
  config: ResolvedConfig,
  define: Record<string, string>,
  plugins: BunPlugin[],
  outDir: string,
  publicEnv: Record<string, string>,
): Promise<void> {
  const prodServePath = await writeProdServe(config, outDir, "prod-serve.ts", {
    envCheck: publicEnv,
  });

  const assets = config.api ? [outDir, config.api] : [outDir];
  const compileOptions = config.compile || {};
  const targets = compileOptions.targets ?? [undefined];
  const binOutDir = join(config.root, compileOptions.outDir ?? "bin");

  // Compiles are CPU-heavy, so overlap them at half the cores; log afterwards in target order.
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
        `[steambun] compile: build failed${target ? ` for ${target}` : ""}.`,
      );
      return outfile;
    },
  );

  for (const outfile of outfiles) {
    log.info(`[steambun] compile: ${relative(config.root, outfile)}`);
  }
}
