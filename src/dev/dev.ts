import { basename } from "node:path";
import { bumpConfigGeneration, loadConfig } from "../config/loader";
import {
  buildBundleDefine,
  filterPublicEnv,
  loadEnvFiles,
  withProcessEnv,
} from "../env/loader";
import { writeEnvDts } from "../env/types";
import { writeRoutesDts } from "../routes-dts";
import { mergeFeatures } from "../util/features";
import { childEnv } from "../util/server-env";
import { discoverHtmlEntries, discoverSkipDirs } from "./discover";
import { synthesizeDevServer } from "./synth";
import { setupDevWatchers } from "./watch";

export interface DevOptions {
  root?: string;
  mode?: string;
  configFile?: string;
  port?: number;
  host?: string | boolean;
  strictPort?: boolean;
  open?: boolean;
}

export async function dev(opts: DevOptions = {}): Promise<void> {
  const mode = opts.mode ?? "development";

  let shuttingDown = false;
  let killedForRestart = false;
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let watcher: { close(): void } | undefined;
  let resumeAfterCrash: (() => void) | null = null;

  function waitForNextChange(): Promise<void> {
    return new Promise((resolve) => {
      resumeAfterCrash = () => {
        resumeAfterCrash = null;
        resolve();
      };
    });
  }

  const shutdown = () => {
    shuttingDown = true;
    watcher?.close();
    proc?.kill();
    resumeAfterCrash?.();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  async function startOnce(): Promise<number> {
    if (shuttingDown) return 0;

    const config = await loadConfig({
      root: opts.root,
      command: "dev",
      mode,
      configFile: opts.configFile,
    });

    if (opts.port) config.server.port = opts.port;
    if (opts.host !== undefined) config.server.host = opts.host;
    if (opts.strictPort !== undefined)
      config.server.strictPort = opts.strictPort;

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
    const publicEnv = filterPublicEnv(
      withProcessEnv(fileEnv),
      config.envPrefix,
    );
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

    if (shuttingDown) return 0;

    console.log(`[steambun] starting dev server (mode: ${mode})`);

    // Bun's dev bundler has no `features` build option in 1.4.1, so
    // config.build.features can't apply here — only the STEAMBUN_FEATURES env
    // var reaches feature() in dev, via --feature= CLI args (verified: bun
    // --hot --feature=X works; a comma-separated single flag does not — one
    // --feature= per flag).
    const featureFlags = mergeFeatures(
      undefined,
      process.env.STEAMBUN_FEATURES,
    );

    proc = Bun.spawn({
      // `--config <path> <script>` (space-separated) silently no-ops on Bun
      // 1.4.0 — verified empirically. `--config=<path>` is the form that works.
      cmd: [
        "bun",
        "--hot",
        `--config=${bunfigPath}`,
        ...featureFlags.map((f) => `--feature=${f}`),
        servePath,
      ],
      cwd: config.root,
      stdio: ["inherit", "inherit", "inherit"],
      env: {
        ...process.env,
        NODE_ENV: "development",
        ...childEnv(opts),
      },
    });

    watcher?.close();
    watcher = setupDevWatchers({
      root: config.root,
      envDir,
      configFileName: config.configFile ? basename(config.configFile) : null,
      onRestart: (filename) => {
        if (shuttingDown || killedForRestart) return;
        killedForRestart = true;
        console.log(
          `[steambun] ${filename ?? "a watched file"} changed, restarting`,
        );
        proc?.kill();
        resumeAfterCrash?.();
      },
    });

    const exitCode = await proc.exited;

    if (shuttingDown) return exitCode;

    if (killedForRestart) {
      killedForRestart = false;
      bumpConfigGeneration();
      return startOnce();
    }

    if (exitCode !== 0) {
      console.log(
        `[steambun] dev server exited (code ${exitCode}) — waiting for a change to restart`,
      );
      await waitForNextChange();
      if (shuttingDown) return 0;
      bumpConfigGeneration();
      return startOnce();
    }

    return exitCode;
  }

  const exitCode = await startOnce();
  watcher?.close();
  if (!shuttingDown) process.exitCode = exitCode;
}
