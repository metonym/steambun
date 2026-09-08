import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type {
  AnalyzeReport,
  BudgetViolation,
  CompareRow,
  CompressedSizes,
} from "./build/analyze";
import {
  analyzeMetafile,
  checkBudgets,
  compareMetafiles,
  computeCompressedSizes,
  explainImport,
} from "./build/analyze";
import { build } from "./build/build";
import { preview } from "./build/preview";
import { renderTreemapHtml } from "./build/treemap";
import { loadConfig } from "./config/loader";
import { migrate } from "./config/migrate";
import { dev } from "./dev/dev";
import {
  discoverHtmlEntries,
  discoverSkipDirs,
  htmlServePath,
} from "./dev/discover";
import { runDoctor } from "./doctor";
import { writeRoutesDts } from "./routes-dts";
import { createApp, formatApiRouteCollision } from "./runtime/app";
import { formatSize } from "./util/format";
import { type LogLevel, log, pad, setLogLevel } from "./util/terminal";

const USAGE = `steambun — a Bun-native, Vite-class dev & bundle toolkit

Usage:
  steambun [dev]           Start the dev server (default command)
  steambun build           Build for production
  steambun preview         Serve the production build locally
  steambun analyze         Report a build size/dependency breakdown from the last build
  steambun routes          Print the route graph without starting a server
  steambun migrate         Convert a vite.config.* into steambun.config.ts
  steambun doctor          Check config conflicts, tsconfig reachability, and secret env keys

Flags:
--port <n>       Port for dev/preview
--host [addr]    Expose on network (dev/preview)
--strictPort     Fail instead of trying the next port (dev, preview)
--open           Open a browser after listen (dev, preview)
--emptyOutDir <true|false>  Empty outDir before building (build)
--logLevel <silent|error|warn|info>  Set log verbosity (default: info)
  --mode <name>    Set mode (default: development for dev, production for build)
  --config <path>  Explicit config file path
  --root <path>    Project root (default: cwd)
  --json           Machine-readable output (analyze, routes, doctor)
  --why <text>     Print import chains to an output/input path containing <text> (analyze)
  --compare <metafile>  Diff outputs against a prior build's metafile.json (analyze)
  --ci             Print ::error/::warning annotations for budgets/growth (analyze) or failing/warning checks (doctor); implied by GITHUB_ACTIONS
  --md             Print the report as GitHub-flavored Markdown tables (analyze)
  --html [out]     Write a treemap HTML report (default <root>/analyze.html) (analyze)
  --brotli         Also compute brotli sizes (slow; opt-in) (analyze)
`;

const LOG_LEVELS: LogLevel[] = ["silent", "error", "warn", "info"];

function commonOptions() {
  return {
    port: { type: "string" as const },
    host: { type: "string" as const },
    strictPort: { type: "boolean" as const },
    open: { type: "boolean" as const },
    emptyOutDir: { type: "string" as const },
    logLevel: { type: "string" as const },
    mode: { type: "string" as const },
    config: { type: "string" as const },
    root: { type: "string" as const },
    json: { type: "boolean" as const },
    why: { type: "string" as const },
    compare: { type: "string" as const },
    ci: { type: "boolean" as const },
    md: { type: "boolean" as const },
    html: { type: "boolean" as const },
    brotli: { type: "boolean" as const },
    help: { type: "boolean" as const, short: "h" },
  };
}

/** `undefined` in → `undefined` out; anything besides `"true"`/`"false"` warns and is ignored. */
export function parseBooleanFlag(
  value: string | undefined,
  flag: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  console.warn(
    `[steambun] --${flag} expects "true" or "false", got "${value}" — ignored.`,
  );
  return undefined;
}

interface AnalyzeCliOptions {
  compare: string | undefined;
  ci: boolean;
  md: boolean;
  html: boolean;
  htmlOut: string | undefined;
  brotli: boolean;
}

/** `"  gzip     800 B  zstd     750 B"`, plus `br` when `brotli` is on. */
function compressedCols(
  sizes: CompressedSizes | undefined,
  brotli: boolean,
): string {
  const cols = [
    `gzip ${pad(sizes ? formatSize(sizes.gzip) : "-", 9, "start")}`,
    `zstd ${pad(sizes ? formatSize(sizes.zstd) : "-", 9, "start")}`,
  ];
  if (brotli) {
    cols.push(
      `br ${pad(sizes?.br !== undefined ? formatSize(sizes.br) : "-", 9, "start")}`,
    );
  }
  return `  ${cols.join("  ")}`;
}

function printTextReport(
  report: AnalyzeReport,
  compressed: Map<string, CompressedSizes>,
  violations: BudgetViolation[],
  compareRows: CompareRow[] | undefined,
  brotli: boolean,
): void {
  log.info("[steambun] outputs (largest first):");
  for (const output of report.outputs) {
    log.info(
      `  ${pad(formatSize(output.bytes), 9, "start")}${compressedCols(compressed.get(output.path), brotli)}  ${output.path}`,
    );
    for (const input of output.inputs.slice(0, 5)) {
      log.info(
        `      ${pad(formatSize(input.bytes), 9, "start")}  ${input.path}`,
      );
    }
  }
  log.info(`  ${pad(formatSize(report.total), 9, "start")}  total`);

  if (report.packages.length > 0) {
    log.info("\n[steambun] packages (largest first):");
    for (const pkg of report.packages.slice(0, 15)) {
      const files = pkg.files === 1 ? "1 file" : `${pkg.files} files`;
      log.info(
        `  ${pad(formatSize(pkg.bytes), 9, "start")}  ${pkg.name}@${pkg.versions.join(",")} (${files})`,
      );
    }
  }

  if (report.duplicates.length > 0) {
    log.info("\n[steambun] duplicate packages:");
    for (const dup of report.duplicates) {
      log.info(`  ${dup.name}: ${dup.versions.join(", ")}`);
    }
  }

  if (violations.length > 0) {
    log.info("\n[steambun] budget violations:");
    for (const v of violations) {
      log.info(
        `  ${v.path}  ${formatSize(v.bytes)} > ${formatSize(v.limit)} ("${v.glob}")`,
      );
    }
  }

  if (compareRows && compareRows.length > 0) {
    log.info("\n[steambun] compared to baseline:");
    for (const row of compareRows) {
      const sign = row.delta >= 0 ? "+" : "-";
      log.info(
        `  ${pad(row.status, 8)} ${pad(formatSize(row.before), 9, "start")} -> ${pad(formatSize(row.after), 9, "start")}  (${sign}${formatSize(Math.abs(row.delta))})  ${row.path}`,
      );
    }
  }
}

function mdTable(headers: string[], rows: string[][]): void {
  log.info(`| ${headers.join(" | ")} |`);
  log.info(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of rows) log.info(`| ${row.join(" | ")} |`);
}

function printMarkdownReport(
  report: AnalyzeReport,
  compressed: Map<string, CompressedSizes>,
  violations: BudgetViolation[],
  compareRows: CompareRow[] | undefined,
  brotli: boolean,
): void {
  const headers = ["Path", "Size", "Gzip", "Zstd", ...(brotli ? ["Br"] : [])];
  log.info("### Outputs\n");
  mdTable(
    headers,
    report.outputs.map((output) => {
      const c = compressed.get(output.path);
      return [
        output.path,
        formatSize(output.bytes),
        c ? formatSize(c.gzip) : "-",
        c ? formatSize(c.zstd) : "-",
        ...(brotli ? [c?.br !== undefined ? formatSize(c.br) : "-"] : []),
      ];
    }),
  );
  log.info(`\n**total**: ${formatSize(report.total)}`);

  if (report.packages.length > 0) {
    log.info("\n### Packages\n");
    mdTable(
      ["Package", "Size", "Files"],
      report.packages
        .slice(0, 15)
        .map((pkg) => [
          `${pkg.name}@${pkg.versions.join(",")}`,
          formatSize(pkg.bytes),
          String(pkg.files),
        ]),
    );
  }

  if (report.duplicates.length > 0) {
    log.info("\n### Duplicate packages\n");
    mdTable(
      ["Package", "Versions"],
      report.duplicates.map((dup) => [dup.name, dup.versions.join(", ")]),
    );
  }

  if (violations.length > 0) {
    log.info("\n### Budget violations\n");
    mdTable(
      ["Path", "Size", "Limit", "Glob"],
      violations.map((v) => [
        v.path,
        formatSize(v.bytes),
        formatSize(v.limit),
        `\`${v.glob}\``,
      ]),
    );
  }

  if (compareRows && compareRows.length > 0) {
    log.info("\n### Compared to baseline\n");
    mdTable(
      ["Path", "Status", "Before", "After", "Delta"],
      compareRows.map((row) => [
        row.path,
        row.status,
        formatSize(row.before),
        formatSize(row.after),
        `${row.delta >= 0 ? "+" : "-"}${formatSize(Math.abs(row.delta))}`,
      ]),
    );
  }
}

function printCiAnnotations(
  violations: BudgetViolation[],
  compareRows: CompareRow[] | undefined,
): void {
  for (const v of violations) {
    console.log(
      `::error file=${v.path}::budget exceeded: ${formatSize(v.bytes)} > ${formatSize(v.limit)} ("${v.glob}")`,
    );
  }
  if (!compareRows) return;
  for (const row of compareRows) {
    if (row.status !== "changed" || row.delta / row.before <= 0.1) continue;
    const pct = ((row.delta / row.before) * 100).toFixed(0);
    console.log(
      `::warning file=${row.path}::grew ${formatSize(row.delta)} (${pct}%) vs the compared build`,
    );
  }
}

async function runAnalyze(
  root: string,
  configFile: string | undefined,
  json: boolean,
  why: string | undefined,
  opts: AnalyzeCliOptions,
): Promise<void> {
  const config = await loadConfig({
    root,
    command: "build",
    mode: "production",
    configFile,
  });
  const metafilePath = join(config.root, ".steambun", "metafile.json");
  if (!existsSync(metafilePath)) {
    log.error(
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
      log.info(`[steambun] No import chain found to "${why}".`);
      return;
    }
    for (const chain of chains) log.info(chain.join(" -> "));
    return;
  }

  const report = analyzeMetafile(metafile);

  let compareRows: CompareRow[] | undefined;
  if (opts.compare) {
    const baseline = JSON.parse(
      await Bun.file(opts.compare).text(),
    ) as Bun.BuildMetafile;
    compareRows = compareMetafiles(baseline, metafile);
  }

  if (json) {
    console.log(
      JSON.stringify(
        compareRows ? { ...report, compare: compareRows } : report,
        null,
        2,
      ),
    );
    return;
  }

  const outDir = join(config.root, config.build.outDir);
  const compressed = await computeCompressedSizes(report.outputs, outDir, {
    brotli: opts.brotli,
  });

  if (opts.html) {
    const htmlOutPath = opts.htmlOut
      ? resolve(process.cwd(), opts.htmlOut)
      : join(config.root, "analyze.html");
    await Bun.write(htmlOutPath, renderTreemapHtml(report));
    log.info(`[steambun] wrote ${htmlOutPath}`);
  }

  const violations = config.build.budgets
    ? checkBudgets(report.outputs, config.build.budgets)
    : [];

  if (opts.md) {
    printMarkdownReport(
      report,
      compressed,
      violations,
      compareRows,
      opts.brotli,
    );
  } else {
    printTextReport(report, compressed, violations, compareRows, opts.brotli);
  }

  if (opts.ci || process.env.GITHUB_ACTIONS) {
    printCiAnnotations(violations, compareRows);
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
  const { skipDirs, skipPaths } = discoverSkipDirs(config);
  const htmlEntries = await discoverHtmlEntries(config.root, {
    skipDirs,
    skipPaths,
  });
  const htmlRoutes: Record<string, unknown> = {};
  for (const entry of htmlEntries) {
    htmlRoutes[htmlServePath(entry, config.appType)] = {};
  }
  await writeRoutesDts(config.root, config.api, htmlEntries, config.appType);
  const app = await createApp({ config, mode: "dev", htmlRoutes });
  const rows = app.routeTable();
  const source = config.api ? relative(config.root, config.api) : "";
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    for (const collision of app.collisions) {
      console.error(formatApiRouteCollision(collision, source));
    }
  } else {
    console.log(Bun.inspect.table(rows));
    for (const collision of app.collisions) {
      console.log(formatApiRouteCollision(collision, source));
    }
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
    "doctor",
  ].includes(command ?? "");
  const args = isKnownCommand ? rest : argv;
  const resolvedCommand = isKnownCommand ? command! : "dev";

  const { values, positionals } = parseArgs({
    args,
    options: commonOptions(),
    allowPositionals: true,
  });

  if (values.help) {
    log.info(USAGE);
    return;
  }

  if (values.logLevel !== undefined) {
    if ((LOG_LEVELS as string[]).includes(values.logLevel)) {
      setLogLevel(values.logLevel as LogLevel);
    } else {
      console.warn(
        `[steambun] --logLevel expects one of ${LOG_LEVELS.join(", ")}, got "${values.logLevel}" — ignored.`,
      );
    }
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
        strictPort: values.strictPort,
        open: values.open,
      });
      return;
    case "build":
      await build({
        root,
        configFile,
        mode: values.mode,
        emptyOutDir: parseBooleanFlag(values.emptyOutDir, "emptyOutDir"),
      });
      return;
    case "preview":
      await preview({
        root,
        configFile,
        mode: values.mode,
        port: values.port ? Number(values.port) : undefined,
        host: values.host !== undefined ? values.host || true : undefined,
        strictPort: values.strictPort,
        open: values.open,
      });
      return;
    case "analyze":
      await runAnalyze(
        root ?? process.cwd(),
        configFile,
        !!values.json,
        values.why,
        {
          compare: values.compare,
          ci: !!values.ci,
          md: !!values.md,
          html: !!values.html,
          htmlOut: positionals[0],
          brotli: !!values.brotli,
        },
      );
      return;
    case "routes":
      await runRoutes(root, configFile, values.mode, !!values.json);
      return;
    case "migrate":
      await migrate(root ?? process.cwd());
      return;
    case "doctor": {
      const result = await runDoctor({
        root,
        configFile,
        json: !!values.json,
        ci: !!values.ci,
      });
      if (!result.ok) process.exitCode = 1;
      return;
    }
    default:
      log.info(USAGE);
      process.exitCode = 1;
  }
}
