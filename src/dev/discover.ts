import { readdir } from "node:fs/promises";
import { isAbsolute, join, posix } from "node:path";
import type { AppType, ResolvedConfig } from "../config/types";
import { posixRelative, toPosix } from "../util/specifier";

export interface HtmlEntry {
  file: string;
  routePath: string;
  isCatchAll: boolean;
}

interface DiscoverHtmlOptions {
  /** Directory names skipped at any depth. */
  skipDirs?: Iterable<string>;
  /** Root-relative POSIX paths skipped exactly. */
  skipPaths?: Iterable<string>;
}

// Dot-directories (`.git`, `.steambun`) are skipped separately.
const DEFAULT_SKIP = ["node_modules", "dist", "public"];

function skipPredicate(opts: DiscoverHtmlOptions) {
  const skipDirs = new Set([...DEFAULT_SKIP, ...(opts.skipDirs ?? [])]);
  const skipPaths = new Set(opts.skipPaths ?? []);
  /** Whether a root-relative POSIX directory path is, or is under, a skipped directory. */
  return (dirPath: string): boolean => {
    const dirs = dirPath.split("/");
    return dirs.some(
      (name, i) =>
        skipDirs.has(name) ||
        name.startsWith(".") ||
        skipPaths.has(dirs.slice(0, i + 1).join("/")),
    );
  };
}

/** Whether `discoverHtmlEntries` (with the same options) never descends into `relPath`'s directories. */
export function isSkippedPath(
  relPath: string,
  opts: DiscoverHtmlOptions = {},
): boolean {
  const dirs = toPosix(relPath).split("/").slice(0, -1);
  return dirs.length > 0 && skipPredicate(opts)(dirs.join("/"));
}

async function collectHtmlFiles(
  root: string,
  dir: string,
  isSkipped: (dirPath: string) => boolean,
): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const childDir = join(dir, entry.name);
      if (isSkipped(posixRelative(root, childDir))) continue;
      files.push(...(await collectHtmlFiles(root, childDir, isSkipped)));
    } else if (entry.name.endsWith(".html")) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

function relToRoute(rel: string): { routePath: string; isCatchAll: boolean } {
  const parts = rel.split("/");
  const file = parts.pop() ?? rel;
  if (file === "index.html") {
    if (parts.length === 0) return { routePath: "/*", isCatchAll: true };
    return { routePath: `/${parts.join("/")}`, isCatchAll: false };
  }
  const name = file.replace(/\.html$/, "");
  const route = [...parts, name].join("/");
  return { routePath: `/${route}`, isCatchAll: false };
}

/** Root `index.html` is `/*` in SPA mode and `/` in MPA mode. */
export function htmlServePath(
  entry: Pick<HtmlEntry, "routePath" | "isCatchAll">,
  appType: AppType,
): string {
  if (entry.isCatchAll && appType === "mpa") return "/";
  return entry.routePath;
}

export async function discoverHtmlEntries(
  root: string,
  opts: DiscoverHtmlOptions = {},
): Promise<HtmlEntry[]> {
  const files = (
    await collectHtmlFiles(root, root, skipPredicate(opts))
  ).sort();
  return files.map((file) => ({
    file,
    ...relToRoute(posixRelative(root, file)),
  }));
}

/** Discovers entries, skipping the configured `build.outDir` and `publicDir`. */
export function discoverConfigHtmlEntries(
  config: Pick<ResolvedConfig, "root" | "build" | "publicDir">,
): Promise<HtmlEntry[]> {
  return discoverHtmlEntries(config.root, discoverSkipDirs(config));
}

export function discoverSkipDirs(config: {
  root?: string;
  build?: { outDir?: string };
  publicDir?: string | false;
}): { skipDirs: string[]; skipPaths: string[] } {
  const skipDirs: string[] = [];
  const skipPaths: string[] = [];
  const { outDir } = config.build ?? {};
  if (outDir) {
    // An absolute outDir only maps to a root-relative skip path when the root is known.
    const rel =
      isAbsolute(outDir) && config.root
        ? posixRelative(config.root, outDir)
        : toPosix(outDir);
    skipPaths.push(posix.normalize(rel).replace(/\/$/, ""));
  }
  if (config.publicDir) {
    const base = toPosix(config.publicDir).split("/").pop();
    if (base) skipDirs.push(base);
  }
  return { skipDirs, skipPaths };
}
