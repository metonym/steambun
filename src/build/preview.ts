import { existsSync } from "node:fs";
import { loadConfig } from "../config/loader";
import { loadEnvFiles, withProcessEnv } from "../env/loader";
import { validateEnv } from "../env/schema";
import { prepareDevCert } from "../util/dev-cert";
import { resolveFrom } from "../util/paths";
import { childEnv } from "../util/server-env";
import { writeProdServe } from "./prod-server";

export interface PreviewOptions {
  root?: string;
  mode?: string;
  configFile?: string;
  port?: number;
  host?: string | boolean;
  strictPort?: boolean;
  open?: boolean;
}

export async function preview(opts: PreviewOptions = {}): Promise<void> {
  const mode = opts.mode ?? "production";
  const config = await loadConfig({
    root: opts.root,
    command: "preview",
    mode,
    configFile: opts.configFile,
  });

  if (opts.host !== undefined) {
    config.server.host = opts.host;
  }

  const outDir = resolveFrom(config.root, config.build.outDir);
  if (!existsSync(outDir)) {
    throw new Error(
      `[steambun] ${config.build.outDir}/ not found. Run \`steambun build\` first.`,
    );
  }

  const env = withProcessEnv(await loadEnvFiles(mode, config.envDir));
  await validateEnv(config.envSchema, env);

  if (config.server.https === true) {
    await prepareDevCert(config, config.server.host);
  }
  const servePath = await writeProdServe(config, outDir, "prod-serve.ts", {
    local: true,
  });

  const proc = Bun.spawn({
    cmd: ["bun", "--no-env-file", servePath],
    cwd: config.root,
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...env, ...childEnv(opts) },
  });

  const shutdown = () => proc.kill();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  process.exitCode = await proc.exited;
}
