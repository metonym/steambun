import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { analyzeMetafile, checkBudgets, explainImport } from "./build/analyze";
import { build } from "./build/build";
import { preview } from "./build/preview";
import { loadConfig } from "./config/loader";
import { migrate } from "./config/migrate";
import { dev } from "./dev/dev";
import {
  discoverHtmlEntries,
  discoverSkipDirs,
  htmlServePath,
} from "./dev/discover";
import { writeRoutesDts } from "./routes-dts";
import { createApp } from "./runtime/app";
import { formatSize } from "./util/format";

const USAGE = `steambun — a Bun-native, Vite-class dev & bundle toolkit

Usage:
  steambun [dev]           Start the dev server (default command)
  steambun build           Build for production
  steambun preview         Serve the production build locally
  steambun analyze         Report a build size/dependency breakdown from the last build
  steambun routes          Print the route graph without starting a server
  steambun migrate         Convert a vite.config.* into steambun.config.ts

Flags:
--port <n>       Port for dev/preview
--host [addr]    Expose on network (dev/preview)
  --mode <name>    Set mode (default: development for dev, production for build)
  --config <path>  Explicit config file path
  --root <path>    Project root (default: cwd)
  --json           Machine-readable output (analyze, routes)
  --why <text>     Print import chains to an output/input path containing <text> (analyze)
`;

function commonOptions() {
  return {
    port: { type: "string" as const },
    host: { type: "string" as const },
    mode: { type: "string" as const },
    config: { type: "string" as const },
    root: { type: "string" as const },
    json: { type: "boolean" as const },
    why: { type: "string" as const },
    help: { type: "boolean" as const, short: "h" },
  };
}

async function runAnalyze(
  root: string,
  configFile: string | undefined,
  json: boolean,
  why: string | undefined,
): Promise<void> {
  const config = await loadConfig({
    root,
    command: "build",
    mode: "production",
    configFile,
  });
  const metafilePath = join(config.root, ".steambun", "metafile.json");
  if (!existsSync(metafilePath)) {
    console.error(
      "[steambun] No build metafile found. Run `steambun build` first.",
    );
    process.exitCode = 1;
    return;
  }
  const metafile = JSON.parse(
    await Bun.file(metafilePath).text(),
  ) as Bun.BuildMetafile;

  if (why) {
    const chains = explainImport(metafile, why);
    if (chains.length === 0) {
      console.log(`[steambun] No import chain found to "${why}".`);
      return;
    }
    for (const chain of chains) console.log(chain.join(" -> "));
    return;
  }

  const report = analyzeMetafile(metafile);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("[steambun] outputs (largest first):");
  for (const output of report.outputs) {
    console.log(`  ${formatSize(output.bytes).padStart(9)}  ${output.path}`);
    for (const input of output.inputs.slice(0, 5)) {
      console.log(
        `      ${formatSize(input.bytes).padStart(9)}  ${input.path}`,
      );
    }
  }
  console.log(`  ${formatSize(report.total).padStart(9)}  total`);

  if (report.packages.length > 0) {
    console.log("\n[steambun] packages (largest first):");
    for (const pkg of report.packages.slice(0, 15)) {
      const files = pkg.files === 1 ? "1 file" : `${pkg.files} files`;
      console.log(
        `  ${formatSize(pkg.bytes).padStart(9)}  ${pkg.name}@${pkg.versions.join(",")} (${files})`,
      );
    }
  }

  if (report.duplicates.length > 0) {
    console.log("\n[steambun] duplicate packages:");
    for (const dup of report.duplicates) {
      console.log(`  ${dup.name}: ${dup.versions.join(", ")}`);
    }
  }

  if (config.build.budgets) {
    const violations = checkBudgets(report.outputs, config.build.budgets);
    if (violations.length > 0) {
      console.log("\n[steambun] budget violations:");
      for (const v of violations) {
        console.log(
          `  ${v.path}  ${formatSize(v.bytes)} > ${formatSize(v.limit)} ("${v.glob}")`,
        );
      }
    }
  }
}

async function runRoutes(
  root: string | undefined,
  configFile: string | undefined,
  mode: string | undefined,
  json: boolean,
): Promise<void> {
  const config = await loadConfig({
    root,
    command: "dev",
    mode: mode ?? "development",
    configFile,
  });
  const htmlEntries = await discoverHtmlEntries(config.root, {
    skipDirs: discoverSkipDirs(config),
  });
  const htmlRoutes: Record<string, unknown> = {};
  for (const entry of htmlEntries) {
    htmlRoutes[htmlServePath(entry, config.appType)] = {};
  }
  await writeRoutesDts(config.root, config.api, htmlEntries, config.appType);
  const app = await createApp({ config, mode: "dev", htmlRoutes });
  const rows = app.routeTable();
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log(Bun.inspect.table(rows));
  }
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const isKnownCommand = [
    "dev",
    "build",
    "preview",
    "analyze",
    "routes",
    "migrate",
  ].includes(command ?? "");
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
      await runAnalyze(
        root ?? process.cwd(),
        configFile,
        !!values.json,
        values.why,
      );
      return;
    case "routes":
      await runRoutes(root, configFile, values.mode, !!values.json);
      return;
    case "migrate":
      await migrate(root ?? process.cwd());
      return;
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}
