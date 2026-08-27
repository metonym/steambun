import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { build } from "./build/build";
import { preview } from "./build/preview";
import { loadConfig } from "./config/loader";
import { dev } from "./dev/dev";

const USAGE = `steambun — a Bun-native, Vite-class dev & bundle toolkit

Usage:
  steambun [dev]           Start the dev server (default command)
  steambun build           Build for production
  steambun preview         Serve the production build locally
  steambun analyze         Report output file sizes from the last build

Flags:
--port <n>       Port for dev/preview
--host [addr]    Expose on network (dev/preview)
  --mode <name>    Set mode (default: development for dev, production for build)
  --config <path>  Explicit config file path
  --root <path>    Project root (default: cwd)
`;

function commonOptions() {
  return {
    port: { type: "string" as const },
    host: { type: "string" as const },
    mode: { type: "string" as const },
    config: { type: "string" as const },
    root: { type: "string" as const },
    help: { type: "boolean" as const, short: "h" },
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function collectFileSizes(
  dir: string,
  base = dir,
): Promise<Array<{ path: string; size: number }>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: Array<{ path: string; size: number }> = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectFileSizes(full, base)));
    } else {
      const { size } = await stat(full);
      results.push({ path: relative(base, full), size });
    }
  }
  return results;
}

async function runAnalyze(root: string, configFile?: string) {
  const config = await loadConfig({
    root,
    command: "build",
    mode: "production",
    configFile,
  });
  const outDirName = config.build.outDir;
  const outDir = join(config.root, outDirName);
  if (!existsSync(outDir)) {
    console.error(
      `[steambun] ${outDirName}/ not found. Run \`steambun build\` first.`,
    );
    process.exitCode = 1;
    return;
  }
  const files = (await collectFileSizes(outDir)).sort(
    (a, b) => b.size - a.size,
  );
  console.log(`[steambun] ${outDirName}/ size report (largest first):`);
  for (const file of files) {
    console.log(`  ${formatSize(file.size).padStart(9)}  ${file.path}`);
  }
  const total = files.reduce((sum, f) => sum + f.size, 0);
  console.log(`  ${formatSize(total).padStart(9)}  total`);
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const isKnownCommand = ["dev", "build", "preview", "analyze"].includes(
    command ?? "",
  );
  const args = isKnownCommand ? rest : argv;
  const resolvedCommand = isKnownCommand ? command! : "dev";

  const { values } = parseArgs({
    args,
    options: commonOptions(),
    allowPositionals: true,
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const root = values.root;
  const configFile = values.config;

  switch (resolvedCommand) {
    case "dev":
      await dev({
        root,
        configFile,
        mode: values.mode,
        port: values.port ? Number(values.port) : undefined,
        host: values.host !== undefined ? values.host || true : undefined,
      });
      return;
    case "build":
      await build({ root, configFile, mode: values.mode });
      return;
    case "preview":
      await preview({
        root,
        configFile,
        mode: values.mode,
        port: values.port ? Number(values.port) : undefined,
        host: values.host !== undefined ? values.host || true : undefined,
      });
      return;
    case "analyze":
      await runAnalyze(root ?? process.cwd(), configFile);
      return;
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}
