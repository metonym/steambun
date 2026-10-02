import type { BunPlugin, ResolvedConfig } from "../config/types";
import { DIST_SERVER_FILE } from "../util/paths";
import {
  assertBuildSuccess,
  commonBuildOptions,
  withBuiltinPlugins,
} from "./options";
import { writeProdServe } from "./prod-server";

/** Bundles the preview server into `outDir/server.js` so `bun dist/server.js` needs no source tree. */
export async function writeDistServer(
  config: ResolvedConfig,
  define: Record<string, string>,
  plugins: BunPlugin[],
  outDir: string,
  publicEnv: Record<string, string>,
): Promise<void> {
  const distServePath = await writeProdServe(config, outDir, "dist-serve.ts", {
    embedOutDir: true,
    envCheck: publicEnv,
  });

  const result = await Bun.build({
    ...commonBuildOptions(config, define),
    entrypoints: [distServePath],
    outdir: outDir,
    naming: DIST_SERVER_FILE,
    target: "bun",
    plugins: withBuiltinPlugins(config, plugins),
  });

  assertBuildSuccess(
    result,
    "[steambun] build.server: bundling dist/server.js failed.",
  );
}
