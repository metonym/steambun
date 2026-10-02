import { basename } from "node:path";
import { bumpConfigGeneration, loadConfig } from "../config/loader";
import type { ResolvedConfig } from "../config/types";
import {
  buildBundleDefine,
  filterPublicEnv,
  loadEnvFiles,
  withProcessEnv,
} from "../env/loader";
import { envSchemaTypes, publicOutput, validateEnv } from "../env/schema";
import { writeEnvDts } from "../env/types";
import { writeRoutesDts } from "../routes-dts";
import { mergeFeatures } from "../util/features";
import { childEnv } from "../util/server-env";
import { log } from "../util/terminal";
import { discoverConfigHtmlEntries, discoverSkipDirs } from "./discover";
import { synthesizeDevServer } from "./synth";
import { setupDevWatchers } from "./watch";

export interface DevCommandOptions {
  root?: string;
  mode?: string;
  configFile?: string;
  port?: number;
  host?: string | boolean;
  strictPort?: boolean;
  open?: boolean;
}

export async function dev(opts: DevCommandOptions = {}): Promise<void> {
  const mode = opts.mode ?? "development";

  let shuttingDown = false;
  let restartRequested = false;
  let started = false;
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let watcher: { close(): void } | undefined;
  let wake: (() => void) | undefined;

  const waitForChange = () =>
    new Promise<void>((resolve) => {
      // A change that landed while starting up must not be waited out.
      if (restartRequested || shuttingDown) return resolve();
      wake = resolve;
    });

  const shutdown = () => {
    shuttingDown = true;
    watcher?.close();
    proc?.kill();
    wake?.();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  function watch(config: ResolvedConfig): void {
    watcher?.close();
    watcher = setupDevWatchers({
      root: config.root,
      envDir: config.envDir,
      configFileName: config.configFile ? basename(config.configFile) : null,
      skip: discoverSkipDirs(config),
      onRestart: (filename) => {
        if (shuttingDown || restartRequested) return;
        restartRequested = true;
        log.info(
          `[steambun] ${filename ?? "a watched file"} changed, restarting`,
        );
        proc?.kill();
        wake?.();
      },
    });
  }

  /** Runs the server once. Resolves to an exit code, or `undefined` to restart. */
  async function startOnce(): Promise<number | undefined> {
    if (shuttingDown) return 0;

    const config = await loadConfig({
      root: opts.root,
      command: "dev",
      mode,
      configFile: opts.configFile,
    });

    if (opts.port !== undefined) config.server.port = opts.port;
    if (opts.host !== undefined) config.server.host = opts.host;
    if (opts.strictPort !== undefined)
      config.server.strictPort = opts.strictPort;

    const htmlEntries = await discoverConfigHtmlEntries(config);
    if (htmlEntries.length === 0) {
      throw new Error(
        `[steambun] No HTML entrypoints found in ${config.root}. Expected an index.html at the project root.`,
      );
    }

    await writeRoutesDts(config.root, config.api, htmlEntries, config.appType);

    const fileEnv = await loadEnvFiles(mode, config.envDir);
    const env = withProcessEnv(fileEnv);
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
      filterPublicEnv(env, config.envPrefix),
      { mode, command: "dev", base: config.base },
      config.define,
      typedPublicEnv,
    );

    const { servePath, bunfigPath } = await synthesizeDevServer(
      config,
      htmlEntries,
      define,
    );

    if (shuttingDown) return 0;

    log.info(`[steambun] starting dev server (mode: ${mode})`);

    // Dev has no `features` build option, so only the env var applies; Bun wants one --feature= per flag.
    const featureFlags = mergeFeatures(
      undefined,
      process.env.STEAMBUN_FEATURES,
    );

    proc = Bun.spawn({
      // `--config <path>` (space-separated) silently no-ops on Bun 1.4.0; `--config=<path>` works.
      cmd: [
        "bun",
        "--no-env-file",
        "--hot",
        `--config=${bunfigPath}`,
        ...featureFlags.map((f) => `--feature=${f}`),
        servePath,
      ],
      cwd: config.root,
      stdio: ["inherit", "inherit", "inherit"],
      env: {
        ...env,
        NODE_ENV: mode === "production" ? "production" : "development",
        ...childEnv(opts),
        // Open a tab on the first start only, not on every restart.
        ...(started && { OPEN: "0" }),
      },
    });

    started = true;
    watch(config);
    // A change during startup was swallowed by `restartRequested` before there was a process to kill.
    if (restartRequested) proc.kill();

    const exitCode = await proc.exited;
    proc = undefined;

    if (shuttingDown) return exitCode;
    if (restartRequested) return undefined;
    if (exitCode === 0) return 0;

    log.info(
      `[steambun] dev server exited (code ${exitCode}) — waiting for a change to restart`,
    );
    await waitForChange();
    return undefined;
  }

  let exitCode: number | undefined;
  try {
    while (exitCode === undefined) {
      try {
        exitCode = await startOnce();
      } catch (error) {
        // Before the first start there is nothing to recover to; afterwards the running watcher picks up the fix.
        if (!started) throw error;
        log.error(error instanceof Error ? error.message : String(error));
        log.info("[steambun] waiting for a change to restart");
        await waitForChange();
      }
      if (exitCode === undefined) {
        restartRequested = false;
        bumpConfigGeneration();
      }
    }
  } finally {
    watcher?.close();
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
  if (!shuttingDown) process.exitCode = exitCode;
}
