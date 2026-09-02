import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { AppType } from "../config/types";

export interface HtmlEntry {
  file: string;
  routePath: string;
  isCatchAll: boolean;
}

export interface DiscoverHtmlOptions {
  skipDirs?: Iterable<string>;
}

const DEFAULT_SKIP = ["node_modules", ".git", ".steambun", "dist", "public"];

async function collectHtmlFiles(
  dir: string,
  skip: Set<string>,
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skip.has(entry.name) || entry.name.startsWith(".")) continue;
      files.push(...(await collectHtmlFiles(join(dir, entry.name), skip)));
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
  const files = (await collectHtmlFiles(root, skip)).sort();
  return files.map((file) => {
    const rel = relative(root, file).split(sep).join("/");
    const { routePath, isCatchAll } = relToRoute(rel);
    return { file, routePath, isCatchAll };
  });
}

export function discoverSkipDirs(config: {
  build?: { outDir?: string };
  publicDir?: string | false;
}): string[] {
  const skip: string[] = [];
  if (config.build?.outDir) skip.push(config.build.outDir);
  if (config.publicDir) {
    const base = config.publicDir.split(/[/\\]/).pop();
    if (base) skip.push(base);
  }
  return skip;
}
