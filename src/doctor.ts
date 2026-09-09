import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { projectBunfigPath, readBunfigFile } from "./config/bunfig";
import { findConfigFile, loadConfig, VITE_CONFIG_NAMES } from "./config/loader";
import type { ResolvedConfig } from "./config/types";
import { discoverHtmlEntries, discoverSkipDirs } from "./dev/discover";
import { filterPublicEnv, loadEnvFiles } from "./env/loader";
import { ciAnnotation } from "./util/annotations";
import { asRecord, asStringArray } from "./util/guards";
import { STEAMBUN_DIR_NAME } from "./util/paths";
import {
  fail as failLine,
  ok as okLine,
  warn as warnLine,
} from "./util/terminal";

export interface Check {
  id: string;
  level: "ok" | "warn" | "fail";
  message: string;
  fix?: string;
}

export interface DoctorOptions {
  root?: string;
  configFile?: string;
  json?: boolean;
}

export interface DoctorResult {
  checks: Check[];
  ok: boolean;
}

const SECRET_KEY_PATTERN = /(SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY)/i;
const GENERATED_TYPE_FILES = [
  `${STEAMBUN_DIR_NAME}/env.d.ts`,
  `${STEAMBUN_DIR_NAME}/routes.d.ts`,
];

export async function runDoctor(
  opts: DoctorOptions = {},
): Promise<DoctorResult> {
  const checks: Check[] = [];

  let config: ResolvedConfig;
  try {
    config = await loadConfig({
      root: opts.root,
      command: "dev",
      mode: "development",
      configFile: opts.configFile,
    });
  } catch (err) {
    checks.push({
      id: "config-load",
      level: "fail",
      message: (err as Error).message,
    });
    return finish(checks, opts);
  }

  checkBunVersion(checks);
  await checkHtmlEntries(checks, config);
  await checkConfigConflicts(checks, config.root);
  await checkTsconfig(checks, config.root);
  await checkGitignore(checks, config.root, config.build.outDir);
  await checkSecretEnvKeys(checks, config);
  await checkEnvInPublicDir(checks, config);
  checkOutdirPlacement(checks, config);

  return finish(checks, opts);
}

function finish(checks: Check[], opts: DoctorOptions): DoctorResult {
  const result: DoctorResult = {
    checks,
    ok: checks.every((check) => check.level !== "fail"),
  };
  printReport(result, opts);
  return result;
}

function printReport(result: DoctorResult, opts: DoctorOptions): void {
  if (opts.json) {
    console.log(
      JSON.stringify({ checks: result.checks, ok: result.ok }, null, 2),
    );
  } else {
    for (const check of result.checks) {
      if (check.level === "ok") console.log(okLine(check.message));
      else if (check.level === "warn") console.log(warnLine(check.message));
      else console.log(failLine(check.message));
      if (check.fix) console.log(`  ${check.fix}`);
    }
  }

  for (const check of result.checks) {
    if (check.level === "fail") ciAnnotation("error", check.message);
    else if (check.level === "warn") ciAnnotation("warning", check.message);
  }
}

function checkBunVersion(checks: Check[]): void {
  const ok = Bun.semver.satisfies(Bun.version, ">=1.4.0");
  checks.push({
    id: "bun-version",
    level: ok ? "ok" : "fail",
    message: ok
      ? `Bun ${Bun.version}`
      : `Bun ${Bun.version} is older than the required 1.4.0 — run \`bun upgrade\``,
  });
}

async function checkHtmlEntries(
  checks: Check[],
  config: ResolvedConfig,
): Promise<void> {
  const { skipDirs, skipPaths } = discoverSkipDirs(config);
  const entries = await discoverHtmlEntries(config.root, {
    skipDirs,
    skipPaths,
  });
  if (entries.length === 0) {
    checks.push({
      id: "html-entries",
      level: "fail",
      message: `No HTML entrypoints found under ${config.root}`,
    });
    return;
  }
  const paths = entries
    .map((entry) => relative(config.root, entry.file))
    .join(", ");
  checks.push({
    id: "html-entries",
    level: "ok",
    message: `${entries.length} HTML ${entries.length === 1 ? "entry" : "entries"}: ${paths}`,
  });
}

async function checkConfigConflicts(
  checks: Check[],
  root: string,
): Promise<void> {
  if (findConfigFile(root)?.kind !== "steambun") return;

  const raw = await readBunfigFile(projectBunfigPath(root));
  if (raw && Object.keys(asRecord(raw.steambun) ?? {}).length > 0) {
    checks.push({
      id: "config-conflict",
      level: "warn",
      message:
        "steambun.config.* wins over bunfig.toml — the [steambun] table is ignored",
    });
  }

  const hasViteConfig = VITE_CONFIG_NAMES.some((name) =>
    existsSync(join(root, name)),
  );
  if (hasViteConfig) {
    checks.push({
      id: "stray-vite-config",
      level: "warn",
      message:
        "vite.config.* is never read while steambun.config.* exists; delete it or run `steambun migrate`",
    });
  }
}

function matchesAny(patterns: string[], target: string): boolean {
  return patterns.some((pattern) => new Bun.Glob(pattern).match(target));
}

async function checkTsconfig(checks: Check[], root: string): Promise<void> {
  const path = join(root, "tsconfig.json");
  if (!existsSync(path)) return;

  let parsed: unknown;
  try {
    parsed = (await import(path, { with: { type: "jsonc" } })).default;
  } catch {
    checks.push({
      id: "tsconfig-reachability",
      level: "warn",
      message: "could not parse tsconfig.json — skipping tsconfig checks",
    });
    return;
  }

  const obj = asRecord(parsed) ?? {};
  const include = asStringArray(obj.include);
  const exclude = asStringArray(obj.exclude);

  let reachable = true;
  if (include && include.length > 0) {
    reachable = GENERATED_TYPE_FILES.some((file) => matchesAny(include, file));
  }
  if (reachable && exclude && exclude.length > 0) {
    reachable = !GENERATED_TYPE_FILES.some((file) => matchesAny(exclude, file));
  }

  checks.push(
    reachable
      ? {
          id: "tsconfig-reachability",
          level: "ok",
          message: "tsconfig.json can see .steambun/'s generated types",
        }
      : {
          id: "tsconfig-reachability",
          level: "fail",
          message:
            "generated types (routes.d.ts, env.d.ts) won't be visible to the editor or tsc — this is an approximation of tsc's own matcher, not exact",
        },
  );

  const compilerOptions = asRecord(obj.compilerOptions) ?? {};
  const types = asStringArray(compilerOptions.types);
  const hasBunTypes =
    types === undefined ||
    types.some((t) => t === "bun-types" || t === "@types/bun");

  checks.push(
    hasBunTypes
      ? {
          id: "tsconfig-types",
          level: "ok",
          message:
            "Bun's ambient types are reachable from compilerOptions.types",
        }
      : {
          id: "tsconfig-types",
          level: "warn",
          message:
            'compilerOptions.types is missing "bun-types" and "@types/bun"',
        },
  );
}

function coversGitignoreEntry(lines: string[], name: string): boolean {
  return lines.some(
    (line) =>
      line === name ||
      line === `${name}/` ||
      line === `/${name}` ||
      line === `/${name}/`,
  );
}

async function checkGitignore(
  checks: Check[],
  root: string,
  outDir: string,
): Promise<void> {
  const path = join(root, ".gitignore");
  if (!existsSync(path)) {
    checks.push({
      id: "gitignore",
      level: "warn",
      message: `.gitignore not found — add ${STEAMBUN_DIR_NAME} and ${outDir}`,
    });
    return;
  }

  const lines = (await Bun.file(path).text())
    .split(/\r?\n/)
    .map((line) => line.trim());

  const missing = [STEAMBUN_DIR_NAME, outDir].filter(
    (name) => !coversGitignoreEntry(lines, name),
  );

  checks.push(
    missing.length === 0
      ? {
          id: "gitignore",
          level: "ok",
          message: `.gitignore covers ${STEAMBUN_DIR_NAME} and ${outDir}`,
        }
      : {
          id: "gitignore",
          level: "warn",
          message: `.gitignore is missing ${missing.join(", ")}`,
        },
  );
}

async function checkSecretEnvKeys(
  checks: Check[],
  config: ResolvedConfig,
): Promise<void> {
  const fileEnv = await loadEnvFiles(config.mode, config.envDir ?? config.root);
  const publicEnv = filterPublicEnv(fileEnv, config.envPrefix);
  const secretKeys = Object.keys(publicEnv).filter((key) =>
    SECRET_KEY_PATTERN.test(key),
  );

  if (secretKeys.length === 0) {
    checks.push({
      id: "secret-env-keys",
      level: "ok",
      message: "no secret-shaped keys in the public env",
    });
    return;
  }

  for (const key of secretKeys) {
    checks.push({
      id: "secret-env-keys",
      level: "fail",
      message: `"${key}" looks like a secret but matches envPrefix — it will be inlined into client JavaScript`,
    });
  }
}

async function checkEnvInPublicDir(
  checks: Check[],
  config: ResolvedConfig,
): Promise<void> {
  if (!config.publicDir || !existsSync(config.publicDir)) return;

  const entries = await readdir(config.publicDir);
  const envFiles = entries.filter((name) => name.startsWith(".env"));

  if (envFiles.length === 0) {
    checks.push({
      id: "env-in-public-dir",
      level: "ok",
      message: "no .env* files in publicDir",
    });
    return;
  }

  for (const name of envFiles) {
    checks.push({
      id: "env-in-public-dir",
      level: "fail",
      message: `"${name}" is inside publicDir and would be served publicly`,
    });
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function checkOutdirPlacement(checks: Check[], config: ResolvedConfig): void {
  const outDir = join(config.root, config.build.outDir);
  const messages: string[] = [];

  if (outDir === config.root) {
    messages.push(`build.outDir resolves to root (${config.root})`);
  }
  if (config.publicDir && isInside(config.publicDir, outDir)) {
    messages.push(
      `build.outDir (${outDir}) is inside publicDir (${config.publicDir})`,
    );
  }

  if (messages.length === 0) {
    checks.push({
      id: "outdir-placement",
      level: "ok",
      message: `build.outDir resolves to ${outDir}`,
    });
    return;
  }
  for (const message of messages) {
    checks.push({ id: "outdir-placement", level: "fail", message });
  }
}
