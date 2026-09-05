import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BunPlugin, ResolvedConfig } from "../config/types";
import { toBunEnvPattern } from "../env/loader";
import { toBunMinify, withAliasPlugin } from "./options";
import { generateProdServeSource } from "./prod-server";

/**
 * Writes `outDir/server.js`: a `bun`-target bundle of the same preview
 * server used by `steambun preview` / `--compile`, with `import.meta.dir`
 * treated as `outDir` itself (since the bundle lives there). Running
 * `bun dist/server.js` has no dependency on the project source tree.
 */
export async function writeDistServer(
  config: ResolvedConfig,
  define: Record<string, string>,
  plugins: BunPlugin[],
  outDir: string,
): Promise<void> {
  const serveDir = join(config.root, ".steambun");
  await mkdir(serveDir, { recursive: true });
  const distServePath = join(serveDir, "dist-serve.ts");
  await writeFile(
    distServePath,
    generateProdServeSource(config, outDir, { embedOutDir: true }),
    "utf8",
  );

  const env = toBunEnvPattern(config.envPrefix);
  const result = await Bun.build({
    entrypoints: [distServePath],
    outdir: outDir,
    naming: "server.js",
    target: "bun",
    define,
    plugins: withAliasPlugin(config, plugins),
    minify: toBunMinify(config.build.minify),
    drop: config.build.drop,
    ...(env ? { env } : {}),
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("[steambun] dist/server.js build failed.");
  }
}
