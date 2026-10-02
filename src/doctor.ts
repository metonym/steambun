import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { projectBunfigPath, readBunfigFile } from "./config/bunfig";
import { configKindOf, findConfigFiles, loadConfig } from "./config/loader";
import type { ResolvedConfig } from "./config/types";
import { discoverConfigHtmlEntries } from "./dev/discover";
import { filterPublicEnv, loadEnvFiles, withProcessEnv } from "./env/loader";
import { EnvValidationError, validateEnv } from "./env/schema";
import { asRecord, asStringArray } from "./util/guards";
import { isInside, resolveFrom, STEAMBUN_DIR_NAME } from "./util/paths";
import {
  fail as failLine,
  ok as okLine,
  warn as warnLine,
} from "./util/terminal";

export interface Check {
  id: string;
  level: "ok" | "warn" | "fail";
  message: string;
}

export interface DoctorOptions {
  root?: string;
  configFile?: string;
  mode?: string;
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

const ok = (id: string, message: string): Check => ({
  id,
  level: "ok",
  message,
});
const warn = (id: string, message: string): Check => ({
  id,
  level: "warn",
  message,
});
const fail = (id: string, message: string): Check => ({
  id,
  level: "fail",
  message,
});

export async function runDoctor(
  opts: DoctorOptions = {},
): Promise<DoctorResult> {
  const checks = await runChecks(opts);
  const result: DoctorResult = {
    checks,
    ok: checks.every((check) => check.level !== "fail"),
  };
  printReport(result, opts.json);
  return result;
}

async function runChecks(opts: DoctorOptions): Promise<Check[]> {
  let config: ResolvedConfig;
  try {
    config = await loadConfig({
      root: opts.root,
      command: "dev",
      mode: opts.mode ?? "development",
      configFile: opts.configFile,
    });
  } catch (err) {
    return [fail("config-load", (err as Error).message)];
  }

  const fileEnv = await loadEnvFiles(config.mode, config.envDir);
  const results = await Promise.all([
    checkBunVersion(),
    checkHtmlEntries(config),
    checkConfigConflicts(config),
    checkTsconfig(config.root),
    checkGitignore(config.root, config.build.outDir),
    checkSecretEnvKeys(config, fileEnv),
    checkEnvSchema(config, fileEnv),
  ]);
  return results.flat();
}

function printReport(result: DoctorResult, json: boolean | undefined): void {
  const line = { ok: okLine, warn: warnLine, fail: failLine };
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const check of result.checks) {
      console.log(line[check.level](check.message));
    }
  }
}

function checkBunVersion(): Check {
  return Bun.semver.satisfies(Bun.version, ">=1.4.0")
    ? ok("bun-version", `Bun ${Bun.version}`)
    : fail(
        "bun-version",
        `Bun ${Bun.version} is older than the required 1.4.0 — run \`bun upgrade\``,
      );
}

async function checkHtmlEntries(config: ResolvedConfig): Promise<Check> {
  const entries = await discoverConfigHtmlEntries(config);
  if (entries.length === 0) {
    return fail(
      "html-entries",
      `No HTML entrypoints found under ${config.root}`,
    );
  }
  const paths = entries
    .map((entry) => relative(config.root, entry.file))
    .join(", ");
  return ok(
    "html-entries",
    `${entries.length} HTML ${entries.length === 1 ? "entry" : "entries"}: ${paths}`,
  );
}

async function checkConfigConflicts(config: ResolvedConfig): Promise<Check[]> {
  if (!config.configFile) return [];
  const winner = configKindOf(config.configFile);
  const checks: Check[] = [];

  if (winner === "steambun") {
    const raw = await readBunfigFile(projectBunfigPath(config.root));
    if (raw && Object.keys(asRecord(raw.steambun) ?? {}).length > 0) {
      checks.push(
        warn(
          "config-conflict",
          "steambun.config.* wins over bunfig.toml — the [steambun] table is ignored",
        ),
      );
    }
  }

  const vite = findConfigFiles(config.root).find(
    (found) => found.kind === "vite",
  );
  if (vite && winner !== "vite") {
    const winnerName =
      winner === "bunfig" ? "bunfig.toml" : "steambun.config.*";
    checks.push(
      warn(
        "stray-vite-config",
        `vite.config.* is never read while ${winnerName} exists; delete it or run \`steambun migrate\``,
      ),
    );
  }
  return checks;
}

// Approximates tsc: an extensionless/non-glob entry names a directory, `./` is optional.
function tsPatternMatches(pattern: string, target: string): boolean {
  const p = pattern.replace(/^\.\//, "").replace(/\/$/, "");
  return (
    p === "." ||
    p === "" ||
    new Bun.Glob(p).match(target) ||
    new Bun.Glob(`${p}/**`).match(target)
  );
}

function matchesAny(patterns: string[]): boolean {
  return GENERATED_TYPE_FILES.some((file) =>
    patterns.some((pattern) => tsPatternMatches(pattern, file)),
  );
}

async function checkTsconfig(root: string): Promise<Check[]> {
  const path = join(root, "tsconfig.json");
  if (!existsSync(path)) return [];

  let obj: Record<string, unknown>;
  try {
    obj = asRecord(Bun.JSONC.parse(await Bun.file(path).text())) ?? {};
  } catch {
    return [
      warn(
        "tsconfig-reachability",
        "could not parse tsconfig.json — skipping tsconfig checks",
      ),
    ];
  }

  const include = asStringArray(obj.include);
  const exclude = asStringArray(obj.exclude);
  const reachable =
    (!include?.length || matchesAny(include)) &&
    !(exclude?.length && matchesAny(exclude));

  return [
    reachable
      ? ok(
          "tsconfig-reachability",
          "tsconfig.json can see .steambun/'s generated types",
        )
      : fail(
          "tsconfig-reachability",
          "generated types (routes.d.ts, env.d.ts) won't be visible to the editor or tsc — this is an approximation of tsc's own matcher, not exact",
        ),
  ];
}

function coversGitignoreEntry(lines: string[], name: string): boolean {
  return lines.some(
    (line) => line.replace(/^\//, "").replace(/\/$/, "") === name,
  );
}

async function checkGitignore(root: string, outDir: string): Promise<Check> {
  const outDirAbs = resolveFrom(root, outDir);
  // An outDir outside the repo has nothing to ignore.
  const names = isInside(root, outDirAbs)
    ? [STEAMBUN_DIR_NAME, relative(root, outDirAbs)]
    : [STEAMBUN_DIR_NAME];
  const path = join(root, ".gitignore");
  if (!existsSync(path)) {
    return warn(
      "gitignore",
      `.gitignore not found — add ${names.join(" and ")}`,
    );
  }

  const lines = (await Bun.file(path).text())
    .split(/\r?\n/)
    .map((line) => line.trim());
  const missing = names.filter((name) => !coversGitignoreEntry(lines, name));
  return missing.length === 0
    ? ok("gitignore", `.gitignore covers ${names.join(" and ")}`)
    : warn("gitignore", `.gitignore is missing ${missing.join(", ")}`);
}

function checkSecretEnvKeys(
  config: ResolvedConfig,
  fileEnv: Record<string, string>,
): Check[] {
  const secretKeys = Object.keys(
    filterPublicEnv(fileEnv, config.envPrefix),
  ).filter((key) => SECRET_KEY_PATTERN.test(key));

  return secretKeys.length === 0
    ? [ok("secret-env-keys", "no secret-shaped keys in the public env")]
    : secretKeys.map((key) =>
        fail(
          "secret-env-keys",
          `"${key}" looks like a secret but matches envPrefix — it will be inlined into client JavaScript`,
        ),
      );
}

async function checkEnvSchema(
  config: ResolvedConfig,
  fileEnv: Record<string, string>,
): Promise<Check[]> {
  if (!config.envSchema) return [];
  try {
    await validateEnv(config.envSchema, withProcessEnv(fileEnv));
    return [ok("env-schema", `env matches envSchema (mode: ${config.mode})`)];
  } catch (error) {
    if (!(error instanceof EnvValidationError)) throw error;
    return error.issues.map((issue) =>
      fail("env-schema", `${issue.path || "(root)"}: ${issue.message}`),
    );
  }
}
