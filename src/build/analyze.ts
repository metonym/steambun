import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compressedSize } from "./precompress";

/** Bun's metafile prefixes top-level output paths with `./`. */
export function stripDotSlash(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

/** Replaces each output's `bytes` with its on-disk size; a missing file keeps the metafile value. */
export async function refreshOutputSizes(
  metafile: Bun.BuildMetafile,
  outDir: string,
): Promise<Bun.BuildMetafile> {
  const entries = await Promise.all(
    Object.entries(metafile.outputs).map(async ([path, output]) => {
      const bytes = await stat(join(outDir, stripDotSlash(path)))
        .then((s) => s.size)
        .catch(() => output.bytes);
      return [path, { ...output, bytes }] as const;
    }),
  );
  return { ...metafile, outputs: Object.fromEntries(entries) };
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

// Metafile input paths are relative to the cwd Bun.build() ran in, not `root`/`outdir`.
function versionForDir(dir: string, cache: Map<string, string>): string {
  const absDir = resolve(process.cwd(), dir);
  const cached = cache.get(absDir);
  if (cached !== undefined) return cached;
  let version = "unknown";
  try {
    const pkg = JSON.parse(readFileSync(join(absDir, "package.json"), "utf8"));
    if (typeof pkg.version === "string") version = pkg.version;
  } catch {}
  cache.set(absDir, version);
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
      path: stripDotSlash(path),
      bytes: output.bytes,
      entryPoint: output.entryPoint,
      inputs,
    });
  }
  outputs.sort((a, b) => b.bytes - a.bytes);

  const packageAgg = new Map<string, PackageAgg>();
  const versionCache = new Map<string, string>();
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
    if (!agg.dirs.has(info.dir)) {
      agg.dirs.add(info.dir);
      agg.versions.add(versionForDir(info.dir, versionCache));
    }
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
  const queue: string[] = [start];
  const parent = new Map<string, string | null>([[start, null]]);
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]!;
    if (node.includes(target)) {
      const chain: string[] = [];
      for (let at: string | null | undefined = node; at; at = parent.get(at)) {
        chain.push(at);
      }
      return chain.reverse();
    }
    const input = metafile.inputs[node];
    if (!input) continue;
    for (const imp of input.imports) {
      if (parent.has(imp.path)) continue;
      parent.set(imp.path, node);
      queue.push(imp.path);
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

const SIZE_UNITS = { b: 1, kb: 1024, mb: 1024 * 1024 };

export function parseSize(input: string | number): number {
  if (typeof input === "number") return input;
  const match = input.trim().match(/^(\d+(?:\.\d+)?|\.\d+)\s*(b|kb|mb)?$/i);
  if (!match) throw new Error(`[steambun] Invalid size budget: "${input}"`);
  const unit = (match[2] ?? "b").toLowerCase() as keyof typeof SIZE_UNITS;
  return Math.round(Number.parseFloat(match[1]!) * SIZE_UNITS[unit]);
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

export interface CompareRow {
  path: string;
  status: "added" | "removed" | "changed";
  before: number;
  after: number;
  delta: number;
}

function outputBytes(metafile: Bun.BuildMetafile): Map<string, number> {
  return new Map(
    Object.entries(metafile.outputs).map(([path, output]) => [
      stripDotSlash(path),
      output.bytes,
    ]),
  );
}

/** Output size diff by normalized path, equal sizes omitted, largest absolute delta first. */
export function compareMetafiles(
  before: Bun.BuildMetafile,
  after: Bun.BuildMetafile,
): CompareRow[] {
  const beforeBytes = outputBytes(before);
  const afterBytes = outputBytes(after);

  const rows: CompareRow[] = [];
  for (const path of new Set([...beforeBytes.keys(), ...afterBytes.keys()])) {
    const b = beforeBytes.get(path);
    const a = afterBytes.get(path);
    if (b === undefined || a === undefined) {
      rows.push({
        path,
        status: a === undefined ? "removed" : "added",
        before: b ?? 0,
        after: a ?? 0,
        delta: (a ?? 0) - (b ?? 0),
      });
    } else if (b !== a) {
      rows.push({ path, status: "changed", before: b, after: a, delta: a - b });
    }
  }
  rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  return rows;
}

export interface CompressedSizes {
  gzip: number;
  br?: number;
  zstd: number;
}

/**
 * Compresses each output's on-disk file with gzip/zstd (and brotli, opt-in —
 * it's slow). Outputs with no file on disk (e.g. a stale metafile) are skipped.
 */
export async function computeCompressedSizes(
  outputs: AnalyzeReport["outputs"],
  outDir: string,
  opts: { brotli: boolean },
): Promise<Map<string, CompressedSizes>> {
  const entries = await Promise.all(
    outputs.map(async (output) => {
      const path = join(outDir, output.path);
      if (!(await Bun.file(path).exists())) return null;

      const [gzip, zstd, br] = await Promise.all([
        compressedSize(path, "gzip"),
        compressedSize(path, "zstd"),
        opts.brotli ? compressedSize(path, "br") : undefined,
      ]);
      return [output.path, { gzip, zstd, br }] as const;
    }),
  );

  return new Map(entries.filter((entry) => entry !== null));
}
