import { loadConfig } from "../config/loader";
import {
  buildBundleDefine,
  filterPublicEnv,
  loadEnvFiles,
  withProcessEnv,
} from "../env/loader";
import { writeEnvDts } from "../env/types";
import { writeRoutesDts } from "../routes-dts";
import { discoverHtmlEntries, discoverSkipDirs } from "./discover";
import { synthesizeDevServer } from "./synth";

export interface DevOptions {
  root?: string;
  mode?: string;
  configFile?: string;
  port?: number;
  host?: string | boolean;
}

export async function dev(opts: DevOptions = {}): Promise<void> {
  const mode = opts.mode ?? "development";
  const config = await loadConfig({
    root: opts.root,
    command: "dev",
    mode,
    configFile: opts.configFile,
  });

  if (opts.port) config.server.port = opts.port;
  if (opts.host !== undefined) config.server.host = opts.host;

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
      command: "dev",
      base: config.base,
    },
    config.define,
  );

  const { servePath, bunfigPath } = await synthesizeDevServer(
    config,
    htmlEntries,
    define,
  );

  console.log(`[steambun] starting dev server (mode: ${mode})`);

  const proc = Bun.spawn({
    // `--config <path> <script>` (space-separated) silently no-ops on Bun
    // 1.4.0 — verified empirically. `--config=<path>` is the form that works.
    cmd: ["bun", "--hot", `--config=${bunfigPath}`, servePath],
    cwd: config.root,
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, NODE_ENV: "development" },
  });

  const shutdown = () => {
    proc.kill();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const exitCode = await proc.exited;
  process.exitCode = exitCode;
}
