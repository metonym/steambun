import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config/loader";
import { childEnv } from "../util/server-env";
import { generateProdServeSource } from "./prod-server";

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
    config.preview = { ...config.preview, host: opts.host };
  }

  const outDir = join(config.root, config.build.outDir);
  if (!existsSync(outDir)) {
    throw new Error(
      `[steambun] ${config.build.outDir}/ not found. Run \`steambun build\` first.`,
    );
  }

  const serveDir = join(config.root, ".steambun");
  await mkdir(serveDir, { recursive: true });
  const servePath = join(serveDir, "prod-serve.ts");
  await writeFile(servePath, generateProdServeSource(config, outDir), "utf8");

  const proc = Bun.spawn({
    cmd: ["bun", servePath],
    cwd: config.root,
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, ...childEnv(opts) },
  });

  const shutdown = () => proc.kill();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  process.exitCode = await proc.exited;
}
