import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Bun's metafile output keys are already relative to `outdir`, just with a
// "./" prefix for top-level files — strip it so budgets glob against the
// same shape as `outDir`-relative paths (e.g. "assets/app.js").
function normalizeOutputPath(path: string): string {
  return path.replace(/^\.\//, "");
}

export interface AnalyzeReport {
  outputs: Array<{
    path: string;
    bytes: number;
    entryPoint?: string;
    inputs: Array<{ path: string; bytes: number }>;
  }>;
  packages: Array<{
    name: string;
    bytes: number;
    versions: string[];
    files: number;
  }>;
  duplicates: Array<{ name: string; versions: string[] }>;
  total: number;
}

export interface BudgetViolation {
  glob: string;
  path: string;
  bytes: number;
  limit: number;
}

interface PackageAgg {
  bytes: number;
  files: number;
  versions: Set<string>;
  dirs: Set<string>;
}

function packageInfo(inputPath: string): { name: string; dir: string } | null {
  const idx = inputPath.lastIndexOf("node_modules/");
  if (idx === -1) return null;
  const rest = inputPath.slice(idx + "node_modules/".length);
  const segments = rest.split("/");
  const first = segments[0] ?? "";
  const nameSegments = first.startsWith("@")
    ? segments.slice(0, 2)
    : segments.slice(0, 1);
  const name = nameSegments.join("/");
  if (!name) return null;
  return { name, dir: `${inputPath.slice(0, idx)}node_modules/${name}` };
}

// Metafile paths are relative to the cwd Bun.build() ran in (verified via
// probe: `root`/`outdir` don't affect it), so package.json lookups resolve
// the same way. Cached by directory since many inputs share one package.
const versionCache = new Map<string, string>();

function versionForDir(dir: string): string {
  const absDir = resolve(process.cwd(), dir);
  const cached = versionCache.get(absDir);
  if (cached !== undefined) return cached;
  let version = "unknown";
  try {
    const pkg = JSON.parse(readFileSync(join(absDir, "package.json"), "utf8"));
    if (typeof pkg.version === "string") version = pkg.version;
  } catch {
    // Unreadable or missing package.json — leave as "unknown".
  }
  versionCache.set(absDir, version);
  return version;
}

export function analyzeMetafile(metafile: Bun.BuildMetafile): AnalyzeReport {
  const outputs: AnalyzeReport["outputs"] = [];
  let total = 0;
  for (const [path, output] of Object.entries(metafile.outputs)) {
    total += output.bytes;
    const inputs = Object.entries(output.inputs)
      .map(([inputPath, info]) => ({
        path: inputPath,
        bytes: info.bytesInOutput,
      }))
      .sort((a, b) => b.bytes - a.bytes);
    outputs.push({
      path: normalizeOutputPath(path),
      bytes: output.bytes,
      entryPoint: output.entryPoint,
      inputs,
    });
  }
  outputs.sort((a, b) => b.bytes - a.bytes);

  const packageAgg = new Map<string, PackageAgg>();
  for (const [inputPath, input] of Object.entries(metafile.inputs)) {
    const info = packageInfo(inputPath);
    if (!info) continue;
    const agg = packageAgg.get(info.name) ?? {
      bytes: 0,
      files: 0,
      versions: new Set<string>(),
      dirs: new Set<string>(),
    };
    agg.bytes += input.bytes;
    agg.files += 1;
    agg.dirs.add(info.dir);
    agg.versions.add(versionForDir(info.dir));
    packageAgg.set(info.name, agg);
  }

  const packages = [...packageAgg.entries()]
    .map(([name, agg]) => ({
      name,
      bytes: agg.bytes,
      versions: [...agg.versions],
      files: agg.files,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const duplicates = [...packageAgg.entries()]
    .filter(([, agg]) => agg.versions.size > 1)
    .map(([name, agg]) => ({ name, versions: [...agg.versions] }));

  return { outputs, packages, duplicates, total };
}

function bfsChain(
  metafile: Bun.BuildMetafile,
  start: string,
  target: string,
): string[] | null {
  const queue: string[][] = [[start]];
  const visited = new Set<string>([start]);
  while (queue.length > 0) {
    const chain = queue.shift()!;
    const last = chain[chain.length - 1]!;
    if (last.includes(target)) return chain;
    const input = metafile.inputs[last];
    if (!input) continue;
    for (const imp of input.imports) {
      if (visited.has(imp.path)) continue;
      visited.add(imp.path);
      queue.push([...chain, imp.path]);
    }
  }
  return null;
}

/** BFS from each entrypoint to the first input path containing `target`. Up to 3 shortest chains. */
export function explainImport(
  metafile: Bun.BuildMetafile,
  target: string,
): string[][] {
  const entryPoints = new Set<string>();
  for (const output of Object.values(metafile.outputs)) {
    if (output.entryPoint) entryPoints.add(output.entryPoint);
  }

  const chains: string[][] = [];
  for (const entry of entryPoints) {
    const chain = bfsChain(metafile, entry, target);
    if (chain) chains.push(chain);
  }
  chains.sort((a, b) => a.length - b.length);
  return chains.slice(0, 3);
}

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
};

export function parseSize(input: string | number): number {
  if (typeof input === "number") return input;
  const match = input.trim().match(/^([\d.]+)\s*(b|kb|mb)?$/i);
  if (!match) throw new Error(`[steambun] Invalid size budget: "${input}"`);
  const value = Number.parseFloat(match[1]!);
  const unit = (match[2] ?? "b").toLowerCase();
  return Math.round(value * (SIZE_UNITS[unit] ?? 1));
}

export function checkBudgets(
  outputs: AnalyzeReport["outputs"],
  budgets: Record<string, string | number>,
): BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  for (const [glob, limitInput] of Object.entries(budgets)) {
    const limit = parseSize(limitInput);
    const matcher = new Bun.Glob(glob);
    for (const output of outputs) {
      if (matcher.match(output.path) && output.bytes > limit) {
        violations.push({
          glob,
          path: output.path,
          bytes: output.bytes,
          limit,
        });
      }
    }
  }
  return violations;
}
