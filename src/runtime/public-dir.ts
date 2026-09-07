import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
    } else {
      files.push(path);
    }
  }
  return files;
}

function urlPathFor(publicDir: string, file: string): string {
  const segments = relative(publicDir, file).split(sep);
  return `/${segments.map(encodeURIComponent).join("/")}`;
}

/**
 * Register each file in `publicDir` as an exact `Bun.serve` route.
 *
 * @example
 * ```ts
 * import { addPublicDirRoutes } from "steambun/runtime";
 *
 * const routes: Record<string, unknown> = {};
 * await addPublicDirRoutes(routes, "./public"); // routes["/favicon.ico"] = Bun.file(...)
 * Bun.serve({ routes });
 * ```
 */
export async function addPublicDirRoutes(
  routes: Record<string, unknown>,
  publicDir: string,
): Promise<void> {
  if (!existsSync(publicDir)) return;
  const files = await collectFiles(publicDir);
  for (const file of files) {
    const urlPath = urlPathFor(publicDir, file);
    if (urlPath in routes) continue;
    routes[urlPath] = Bun.file(file);
  }
}
