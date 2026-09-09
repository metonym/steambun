import { readdir } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import type { WebSocketRouteHandlers } from "./ws-routes";

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
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && ROUTE_EXTENSIONS.has(extname(entry.name))) {
      files.push(join(entry.parentPath, entry.name));
    }
  }
  return files;
}

/**
 * Maps one filename segment to its Bun route piece and specificity score in
 * a single pass (a literal segment scores 0, a `[param]` segment 1, a
 * `[...catchAll]` / `[[...optionalCatchAll]]` segment 2 — so `index.ts` (0)
 * beats `[[...slug]].ts` (2) for `/api`, and a `:param` beats a `*`).
 */
function segmentToBun(
  segment: string,
):
  | { kind: "optional-catch-all"; score: number }
  | { kind: "part"; value: string; score: number } {
  if (/^\[\[\.\.\.(.+)\]\]$/.test(segment)) {
    return { kind: "optional-catch-all", score: 2 };
  }
  const catchAll = segment.match(/^\[\.\.\.(.+)\]$/);
  if (catchAll) return { kind: "part", value: "*", score: 2 };
  const dyn = segment.match(/^\[(.+)\]$/);
  if (dyn) return { kind: "part", value: `:${dyn[1]}`, score: 1 };
  return { kind: "part", value: segment, score: 0 };
}

/**
 * Bun route paths and specificity score for one apiDir-relative filename, in
 * a single pass over its segments. `score` is the sum of each segment's
 * specificity (see {@link segmentToBun}) — lower is more specific.
 */
function apiPathsAndScore(rel: string): { paths: string[]; score: number } {
  const withoutExt = rel.replace(/\.[^/.]+$/, "");
  const withoutIndex = withoutExt.replace(/(^|\/)index$/, "");
  const segments = withoutIndex.split("/").filter(Boolean);

  const parts: string[] = [];
  let score = 0;
  let optionalCatchAll = false;
  for (const segment of segments) {
    const mapped = segmentToBun(segment);
    score += mapped.score;
    if (mapped.kind === "optional-catch-all") {
      optionalCatchAll = true;
      break;
    }
    parts.push(mapped.value);
  }

  const base = parts.length === 0 ? "/api" : `/api/${parts.join("/")}`;
  const paths = optionalCatchAll ? [base, `${base}/*`] : [base];
  return { paths, score };
}

/** `users/[id].ts` → `/api/users/:id`. Optional catch-all yields two paths. */
export function fileToApiPaths(rel: string): string[] {
  return apiPathsAndScore(rel).paths;
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

function isWebSocketRouteHandlers(
  value: unknown,
): value is WebSocketRouteHandlers {
  if (!value || typeof value !== "object") return false;
  const handlers = value as Record<string, unknown>;
  return (
    typeof handlers.open === "function" ||
    typeof handlers.message === "function" ||
    typeof handlers.close === "function"
  );
}

export interface ApiFileEntry {
  file: string;
  /** apiDir-relative path with forward slashes, e.g. "users/[id].ts" */
  rel: string;
  paths: string[];
  /** Specificity score — lower wins a collision. See {@link fileToApiPaths}. */
  score: number;
}

const WEBSOCKET_EXPORT_RE = /\bexport\s+const\s+websocket\b/;

/** Whether `file` textually contains `export const websocket` — cheap and import-free, like {@link listApiFileEntries}. */
export async function hasWebsocketExport(file: string): Promise<boolean> {
  try {
    return WEBSOCKET_EXPORT_RE.test(await Bun.file(file).text());
  } catch {
    return false;
  }
}

/** Every route file under `apiDir` with the paths it maps to, without importing it. Sorted by `rel`. */
export async function listApiFileEntries(
  apiDir: string,
): Promise<ApiFileEntry[]> {
  const files = await collectFiles(apiDir);
  const entries = files.map((file) => {
    const rel = relative(apiDir, file).split(sep).join("/");
    const { paths, score } = apiPathsAndScore(rel);
    return { file, rel, paths, score };
  });
  entries.sort((a, b) => a.rel.localeCompare(b.rel, "en"));
  return entries;
}

export interface ApiRouteCollision {
  path: string;
  /** apiDir-relative path of the file that served the route */
  winner: string;
  /** apiDir-relative path of the file that was shadowed */
  loser: string;
}

export interface ApiModules {
  routes: Record<string, unknown>;
  websockets: Map<string, WebSocketRouteHandlers>;
  collisions: ApiRouteCollision[];
  /** apiDir-relative file that owns each route path */
  fileForPath: Map<string, string>;
}

interface RouteOwner {
  rel: string;
  score: number;
}

/** Registers `rel`/`score` as the owner of `path` if it wins by specificity; records a collision either way. */
function resolveCollision(
  owners: Map<string, RouteOwner>,
  collisions: ApiRouteCollision[],
  path: string,
  rel: string,
  score: number,
): boolean {
  const current = owners.get(path);
  if (!current) {
    owners.set(path, { rel, score });
    return true;
  }
  if (score < current.score) {
    collisions.push({ path, winner: rel, loser: current.rel });
    owners.set(path, { rel, score });
    return true;
  }
  collisions.push({ path, winner: current.rel, loser: rel });
  return false;
}

/**
 * Loads every file under `apiDir` into HTTP route handlers and, for files
 * exporting `websocket`, a map of route path → WebSocket handlers. Backs
 * both {@link loadApiRoutes} (HTTP only) and `createApp`'s WebSocket wiring.
 * Modules import concurrently (startup only), but collisions still resolve
 * in sorted order: when two files map to the same path the more specific
 * one wins (see {@link fileToApiPaths}), ties go to the lexically-first
 * file.
 */
export async function loadApiModules(apiDir: string): Promise<ApiModules> {
  const entries = await listApiFileEntries(apiDir);
  const mods = await Promise.all(
    entries.map(
      (entry) => import(entry.file) as Promise<Record<string, unknown>>,
    ),
  );

  const routes: Record<string, unknown> = {};
  const websockets = new Map<string, WebSocketRouteHandlers>();
  const collisions: ApiRouteCollision[] = [];
  const routeOwners = new Map<string, RouteOwner>();
  const wsOwners = new Map<string, RouteOwner>();

  entries.forEach(({ rel, paths, score }, i) => {
    const mod = mods[i]!;

    const handler = handlerFromModule(mod);
    if (handler) {
      for (const path of paths) {
        if (resolveCollision(routeOwners, collisions, path, rel, score)) {
          routes[path] = handler;
        }
      }
    }

    if (isWebSocketRouteHandlers(mod.websocket)) {
      for (const path of paths) {
        if (resolveCollision(wsOwners, collisions, path, rel, score)) {
          websockets.set(path, mod.websocket);
        }
      }
    }
  });

  const fileForPath = new Map<string, string>();
  for (const [path, owner] of routeOwners) fileForPath.set(path, owner.rel);
  for (const [path, owner] of wsOwners)
    if (!fileForPath.has(path)) fileForPath.set(path, owner.rel);

  return { routes, websockets, collisions, fileForPath };
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
  return (await loadApiModules(apiDir)).routes;
}
