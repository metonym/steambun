import { readdir } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
] as const;
const ROUTE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
    } else if (ROUTE_EXTENSIONS.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

function segmentToBun(
  segment: string,
): { kind: "optional-catch-all" } | { kind: "part"; value: string } {
  if (/^\[\[\.\.\.(.+)\]\]$/.test(segment)) {
    return { kind: "optional-catch-all" };
  }
  const catchAll = segment.match(/^\[\.\.\.(.+)\]$/);
  if (catchAll) return { kind: "part", value: "*" };
  const dyn = segment.match(/^\[(.+)\]$/);
  if (dyn) return { kind: "part", value: `:${dyn[1]}` };
  return { kind: "part", value: segment };
}

/** `users/[id].ts` → `/api/users/:id`. Optional catch-all yields two paths. */
export function fileToApiPaths(rel: string): string[] {
  const withoutExt = rel.replace(/\.[^/.]+$/, "");
  const withoutIndex = withoutExt.replace(/(^|\/)index$/, "");
  const segments = withoutIndex.split("/").filter(Boolean);

  const parts: string[] = [];
  let optionalCatchAll = false;
  for (const segment of segments) {
    const mapped = segmentToBun(segment);
    if (mapped.kind === "optional-catch-all") {
      optionalCatchAll = true;
      break;
    }
    parts.push(mapped.value);
  }

  const base = parts.length === 0 ? "/api" : `/api/${parts.join("/")}`;
  if (optionalCatchAll) return [base, `${base}/*`];
  return [base];
}

function handlerFromModule(mod: Record<string, unknown>): unknown | null {
  const methodHandlers: Record<string, unknown> = {};
  for (const method of HTTP_METHODS) {
    if (typeof mod[method] === "function") methodHandlers[method] = mod[method];
  }
  if (Object.keys(methodHandlers).length > 0) return methodHandlers;
  if (typeof mod.default === "function") return mod.default;
  return null;
}

/**
 * Named HTTP-method exports (GET/POST/...) map to per-method handlers; a
 * default export handles all methods. `[id]` / `[...slug]` / `[[...slug]]`
 * file names become Bun.serve `:param` / `*` routes.
 *
 * @example
 * ```ts
 * import { loadApiRoutes } from "steambun/runtime";
 *
 * // src/api/users/[id].ts exporting `GET` → routes["/api/users/:id"]
 * const routes = await loadApiRoutes("./src/api");
 * Bun.serve({ routes });
 * ```
 */
export async function loadApiRoutes(
  apiDir: string,
): Promise<Record<string, unknown>> {
  const files = await collectFiles(apiDir);
  const routes: Record<string, unknown> = {};

  for (const file of files) {
    const rel = relative(apiDir, file).split(sep).join("/");
    const paths = fileToApiPaths(rel);
    const mod = (await import(file)) as Record<string, unknown>;
    const handler = handlerFromModule(mod);
    if (!handler) continue;
    for (const path of paths) routes[path] = handler;
  }

  return routes;
}
