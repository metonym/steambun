import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type AnalyzeReport,
  analyzeMetafile,
  type BudgetViolation,
  type CompareRow,
  type CompressedSizes,
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
import { discoverConfigHtmlEntries, htmlServePath } from "./dev/discover";
import { runDoctor } from "./doctor";
import { createApp } from "./runtime/app";
import { formatSize } from "./util/format";
import { resolveFrom, STEAMBUN_DIR_NAME } from "./util/paths";
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
  --host [addr]    Bind address; without a value, bind every interface (dev, preview)
  --strictPort     Fail instead of trying the next port (dev, preview)
  --open           Open a browser after listen (dev, preview); --no-open overrides server.open
  --[no-]emptyOutDir  Empty outDir before building (build)
  --logLevel <silent|error|warn|info>  Set log verbosity (default: info)
  --mode <name>    Mode (default: production for build, preview, analyze; development otherwise)
  --config <path>  Explicit config file path
  --root <path>    Project root (default: cwd)
  --json           Machine-readable output (analyze, routes, doctor)
  --why <text>     Print import chains to an output/input path containing <text> (analyze)
  --compare <metafile>  Diff outputs against a prior build's metafile.json (analyze)
  --html [out]     Write a treemap HTML report (default <root>/analyze.html) (analyze)
  --brotli         Also compute brotli sizes (slow; opt-in) (analyze)
`;

const LOG_LEVELS: LogLevel[] = ["silent", "error", "warn", "info"];

const OPTIONS = {
  port: { type: "string" },
  host: { type: "string" },
  strictPort: { type: "boolean" },
  open: { type: "boolean" },
  emptyOutDir: { type: "boolean" },
  logLevel: { type: "string" },
  mode: { type: "string" },
  config: { type: "string" },
  root: { type: "string" },
  json: { type: "boolean" },
  why: { type: "string" },
  compare: { type: "string" },
  html: { type: "string" },
  brotli: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

const SERVER_COMMANDS = ["dev", "preview"];
const CONFIGURED_COMMANDS = [
  ...SERVER_COMMANDS,
  "build",
  "analyze",
  "routes",
  "doctor",
];

// Flags absent here (root, logLevel, help) apply to every command.
const FLAG_COMMANDS: Partial<Record<keyof typeof OPTIONS, readonly string[]>> =
  {
    config: CONFIGURED_COMMANDS,
    mode: CONFIGURED_COMMANDS,
    port: SERVER_COMMANDS,
    host: SERVER_COMMANDS,
    strictPort: SERVER_COMMANDS,
    open: SERVER_COMMANDS,
    emptyOutDir: ["build"],
    json: ["analyze", "routes", "doctor"],
    why: ["analyze"],
    compare: ["analyze"],
    html: ["analyze"],
    brotli: ["analyze"],
  };

// Flag -> flags that make no sense alongside it in `analyze`.
const ANALYZE_CONFLICTS: Array<[string, string[]]> = [
  ["json", ["html", "why", "brotli"]],
  ["why", ["html", "compare", "brotli"]],
];

function assertFlagsApply(values: Values, command: string): void {
  for (const flag of Object.keys(values)) {
    const commands = FLAG_COMMANDS[flag as keyof typeof OPTIONS];
    if (commands && !commands.includes(command)) {
      throw new Error(`[steambun] --${flag} does not apply to \`${command}\``);
    }
  }
}

function assertAnalyzeFlagsCompatible(values: Values): void {
  const given = (flag: string) => values[flag as keyof Values] !== undefined;
  for (const [flag, conflicts] of ANALYZE_CONFLICTS) {
    const other = given(flag) ? conflicts.find(given) : undefined;
    if (other) {
      throw new Error(
        `[steambun] --${flag} cannot be combined with --${other}`,
      );
    }
  }
}

// parseArgs has no optional-value options; `--flag=` (empty value) means "flag without a value".
const OPTIONAL_VALUE_FLAGS = new Set(["--host", "--html"]);

function withEmptyOptionalValues(args: string[]): string[] {
  return args.map((arg, i) =>
    OPTIONAL_VALUE_FLAGS.has(arg) &&
    (args[i + 1] === undefined || args[i + 1]!.startsWith("-"))
      ? `${arg}=`
      : arg,
  );
}

type Values = ReturnType<typeof parseCliArgs>["values"];

function parseCliArgs(args: string[]) {
  try {
    return parseArgs({
      args,
      options: OPTIONS,
      allowPositionals: true,
      allowNegative: true,
    });
  } catch (err) {
    throw new Error(`[steambun] ${(err as Error).message}`);
  }
}

function flagError(flag: string, expected: string, got: string): Error {
  return new Error(`[steambun] --${flag} expects ${expected}, got "${got}"`);
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw flagError("port", "an integer from 1 to 65535", value);
  }
  return port;
}

function serverFlags(values: Values) {
  return {
    port: parsePort(values.port),
    host: values.host === undefined ? undefined : values.host || true,
    strictPort: values.strictPort,
    open: values.open,
  };
}

interface Ctx {
  values: Values;
  root: string;
}

const projectOptions = ({ values, root }: Ctx) => ({
  root,
  configFile: values.config,
  mode: values.mode,
});

const sizeOrDash = (bytes: number | undefined) =>
  bytes === undefined ? "-" : formatSize(bytes);

const signedSize = (delta: number) =>
  `${delta >= 0 ? "+" : "-"}${formatSize(Math.abs(delta))}`;

interface AnalyzeView {
  report: AnalyzeReport;
  compressed: Map<string, CompressedSizes>;
  violations: BudgetViolation[];
  compareRows: CompareRow[];
  brotli: boolean;
}

const PACKAGE_LIMIT = 15;
const INPUTS_PER_OUTPUT = 5;

function printTextReport(view: AnalyzeView): void {
  const { report, compressed, violations, compareRows, brotli } = view;
  const size = (bytes: number | undefined) =>
    pad(sizeOrDash(bytes), 9, "start");

  console.log("[steambun] outputs (largest first):");
  for (const output of report.outputs) {
    const sizes = compressed.get(output.path);
    const cols = [
      `gzip ${size(sizes?.gzip)}`,
      `zstd ${size(sizes?.zstd)}`,
      ...(brotli ? [`br ${size(sizes?.br)}`] : []),
    ];
    console.log(`  ${size(output.bytes)}  ${cols.join("  ")}  ${output.path}`);
    for (const input of output.inputs.slice(0, INPUTS_PER_OUTPUT)) {
      console.log(`      ${size(input.bytes)}  ${input.path}`);
    }
  }
  console.log(`  ${size(report.total)}  total`);

  if (report.packages.length > 0) {
    console.log("\n[steambun] packages (largest first):");
    for (const pkg of report.packages.slice(0, PACKAGE_LIMIT)) {
      const files = pkg.files === 1 ? "1 file" : `${pkg.files} files`;
      console.log(
        `  ${size(pkg.bytes)}  ${pkg.name}@${pkg.versions.join(",")} (${files})`,
      );
    }
  }

  if (report.duplicates.length > 0) {
    console.log("\n[steambun] duplicate packages:");
    for (const dup of report.duplicates) {
      console.log(`  ${dup.name}: ${dup.versions.join(", ")}`);
    }
  }

  if (violations.length > 0) {
    console.log("\n[steambun] budget violations:");
    for (const v of violations) {
      console.log(
        `  ${v.path}  ${formatSize(v.bytes)} > ${formatSize(v.limit)} ("${v.glob}")`,
      );
    }
  }

  if (compareRows.length > 0) {
    console.log("\n[steambun] compared to baseline:");
    for (const row of compareRows) {
      console.log(
        `  ${pad(row.status, 8)} ${size(row.before)} -> ${size(row.after)}  (${signedSize(row.delta)})  ${row.path}`,
      );
    }
  }
}

const readMetafile = async (path: string) =>
  (await Bun.file(path).json()) as Bun.BuildMetafile;

async function runAnalyze(ctx: Ctx): Promise<void> {
  const { values } = ctx;
  assertAnalyzeFlagsCompatible(values);
  const config = await loadConfig({
    ...projectOptions(ctx),
    command: "build",
    mode: values.mode ?? "production",
  });
  const metafilePath = join(config.root, STEAMBUN_DIR_NAME, "metafile.json");
  if (!(await Bun.file(metafilePath).exists())) {
    log.error(
      "[steambun] No build metafile found. Run `steambun build` first.",
    );
    process.exitCode = 1;
    return;
  }
  const metafile = await readMetafile(metafilePath);

  if (values.why) {
    const chains = explainImport(metafile, values.why);
    if (chains.length === 0) {
      console.log(`[steambun] No import chain found to "${values.why}".`);
    }
    for (const chain of chains) console.log(chain.join(" -> "));
    return;
  }

  const report = analyzeMetafile(metafile);
  const compareRows = values.compare
    ? compareMetafiles(await readMetafile(values.compare), metafile)
    : undefined;

  if (values.json) {
    console.log(
      JSON.stringify(
        compareRows ? { ...report, compare: compareRows } : report,
        null,
        2,
      ),
    );
    return;
  }

  const brotli = !!values.brotli;
  const view: AnalyzeView = {
    report,
    compressed: await computeCompressedSizes(
      report.outputs,
      resolveFrom(config.root, config.build.outDir),
      { brotli },
    ),
    violations: config.build.budgets
      ? checkBudgets(report.outputs, config.build.budgets)
      : [],
    compareRows: compareRows ?? [],
    brotli,
  };

  if (values.html !== undefined) {
    const htmlOutPath = values.html
      ? resolve(values.html)
      : join(config.root, "analyze.html");
    await Bun.write(htmlOutPath, renderTreemapHtml(report));
    log.info(`[steambun] wrote ${htmlOutPath}`);
  }

  printTextReport(view);
  if (view.violations.length > 0) process.exitCode = 1;
}

async function runRoutes(ctx: Ctx): Promise<void> {
  const { values } = ctx;
  const config = await loadConfig({
    ...projectOptions(ctx),
    command: "dev",
    mode: values.mode ?? "development",
  });
  const htmlEntries = await discoverConfigHtmlEntries(config);
  const app = await createApp({
    config,
    mode: "dev",
    htmlRoutes: Object.fromEntries(
      htmlEntries.map((entry) => [htmlServePath(entry, config.appType), {}]),
    ),
  });
  const rows = app.routeTable();
  console.log(
    values.json ? JSON.stringify(rows, null, 2) : Bun.inspect.table(rows),
  );
}

const COMMANDS: Record<string, (ctx: Ctx) => Promise<void>> = {
  dev: (ctx) => dev({ ...projectOptions(ctx), ...serverFlags(ctx.values) }),
  build: (ctx) =>
    build({
      ...projectOptions(ctx),
      emptyOutDir: ctx.values.emptyOutDir,
    }),
  preview: (ctx) =>
    preview({ ...projectOptions(ctx), ...serverFlags(ctx.values) }),
  analyze: runAnalyze,
  routes: runRoutes,
  migrate: ({ root }) => migrate(root),
  doctor: async (ctx) => {
    const { ok } = await runDoctor({
      ...projectOptions(ctx),
      json: ctx.values.json,
    });
    if (!ok) process.exitCode = 1;
  },
};

export async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseCliArgs(withEmptyOptionalValues(argv));
  const [command = "dev", ...extra] = positionals;

  if (values.help) {
    console.log(USAGE);
    return;
  }

  if (!Object.hasOwn(COMMANDS, command)) {
    throw new Error(`[steambun] unknown command "${command}"`);
  }
  if (extra.length > 0) {
    throw new Error(
      `[steambun] unexpected argument "${extra[0]}" for \`${command}\``,
    );
  }
  assertFlagsApply(values, command);

  const logLevel = values.logLevel ?? "info";
  if (!LOG_LEVELS.includes(logLevel as LogLevel)) {
    throw flagError("logLevel", `one of ${LOG_LEVELS.join(", ")}`, logLevel);
  }
  setLogLevel(logLevel as LogLevel);

  await COMMANDS[command]!({ values, root: resolve(values.root ?? ".") });
}
