import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AppType } from "../config/types";
import { STEAMBUN_DIR_NAME } from "../util/paths";
import { posixRelative, toPosix } from "../util/specifier";

export interface HtmlEntry {
  file: string;
  routePath: string;
  isCatchAll: boolean;
}

export interface DiscoverHtmlOptions {
  skipDirs?: Iterable<string>;
  skipPaths?: Iterable<string>;
}

const DEFAULT_SKIP = [
  "node_modules",
  ".git",
  STEAMBUN_DIR_NAME,
  "dist",
  "public",
];

async function collectHtmlFiles(
  root: string,
  dir: string,
  skip: Set<string>,
  skipPaths: Set<string>,
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skip.has(entry.name) || entry.name.startsWith(".")) continue;
      const childDir = join(dir, entry.name);
      const rel = posixRelative(root, childDir);
      if (skipPaths.has(rel)) continue;
      files.push(...(await collectHtmlFiles(root, childDir, skip, skipPaths)));
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
  const skip = new Set(
    opts.skipDirs ? [...DEFAULT_SKIP, ...opts.skipDirs] : DEFAULT_SKIP,
  );
  const skipPaths = new Set(opts.skipPaths ?? []);
  const files = (await collectHtmlFiles(root, root, skip, skipPaths)).sort();
  return files.map((file) => {
    const rel = posixRelative(root, file);
    const { routePath, isCatchAll } = relToRoute(rel);
    return { file, routePath, isCatchAll };
  });
}

export function discoverSkipDirs(config: {
  build?: { outDir?: string };
  publicDir?: string | false;
}): { skipDirs: string[]; skipPaths: string[] } {
  const skipDirs: string[] = [];
  const skipPaths: string[] = [];
  if (config.build?.outDir) {
    const normalized = toPosix(config.build.outDir);
    const [firstSegment] = normalized.split("/");
    if (firstSegment) skipDirs.push(firstSegment);
    skipPaths.push(normalized);
  }
  if (config.publicDir) {
    const base = toPosix(config.publicDir).split("/").pop();
    if (base) skipDirs.push(base);
  }
  return { skipDirs, skipPaths };
}
