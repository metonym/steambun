import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { posixRelative } from "../util/specifier";
import type { RouteHandler } from "./middleware";
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
/** In precedence order: when `a.ts` and `a.tsx` both exist, `a.ts` serves the route. */
const ROUTE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const NON_ROUTE_FILE_RE = /\.(?:d|test|spec)\.[jt]sx?$/;

/** Declaration files, `*.test.*`/`*.spec.*`, and anything under an `_`-prefixed file or directory are not routes. */
function isRouteFile(rel: string): boolean {
  if (!ROUTE_EXTENSIONS.includes(extname(rel))) return false;
  if (NON_ROUTE_FILE_RE.test(rel)) return false;
  return !rel.split("/").some((segment) => segment.startsWith("_"));
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    if (isRouteFile(posixRelative(dir, file))) files.push(file);
  }
  return files;
}

const CATCH_ALL = /^\[\.\.\..+\]$/;
const OPTIONAL_CATCH_ALL = /^\[\[\.\.\..+\]\]$/;

/** Every API route lives under this prefix. */
export const API_PREFIX = "/api";

export const isApiPath = (path: string) =>
  path === API_PREFIX || path.startsWith(`${API_PREFIX}/`);

function segmentToBun(segment: string): string {
  if (CATCH_ALL.test(segment)) return "*";
  const param = segment.match(/^\[(.+)\]$/);
  return param ? `:${param[1]}` : segment;
}

/** Bun route paths for one apiDir-relative filename; `optional` when `[[...x]]` also claims its parent path. */
function apiPaths(rel: string): { paths: string[]; optional: boolean } {
  const withoutExt = rel.replace(/\.[^/.]+$/, "");
  const withoutIndex = withoutExt.replace(/(^|\/)index$/, "");
  const segments = withoutIndex.split("/").filter(Boolean);

  const parts: string[] = [];
  let optional = false;
  segments.forEach((segment, i) => {
    const isOptional = OPTIONAL_CATCH_ALL.test(segment);
    if (i < segments.length - 1 && (isOptional || CATCH_ALL.test(segment))) {
      throw new Error(
        `[steambun] api route ${rel}: catch-all ${segment} must be the last path segment`,
      );
    }
    optional ||= isOptional;
    if (!isOptional) parts.push(segmentToBun(segment));
  });

  const base =
    parts.length === 0 ? API_PREFIX : `${API_PREFIX}/${parts.join("/")}`;
  return { paths: optional ? [base, `${base}/*`] : [base], optional };
}

function handlerFromModule(
  mod: Record<string, unknown>,
): ApiHandler | undefined {
  const methods: Record<string, RouteHandler> = {};
  for (const method of HTTP_METHODS) {
    if (typeof mod[method] === "function") {
      methods[method] = mod[method] as RouteHandler;
    }
  }
  if (Object.keys(methods).length > 0) return methods;
  return typeof mod.default === "function"
    ? (mod.default as RouteHandler)
    : undefined;
}

function isWebSocketRouteHandlers(
  value: unknown,
): value is WebSocketRouteHandlers {
  const handlers = value as Record<string, unknown> | null;
  return (
    typeof handlers?.open === "function" ||
    typeof handlers?.message === "function" ||
    typeof handlers?.close === "function"
  );
}

/** Whether `file` exports `websocket` in any form (`const`, `function`, `export { x as websocket }`), without importing it. */
export async function hasWebsocketExport(file: string): Promise<boolean> {
  try {
    const loader = extname(file).slice(1) as "ts" | "tsx" | "js" | "jsx";
    return new Bun.Transpiler({ loader })
      .scan(await Bun.file(file).text())
      .exports.includes("websocket");
  } catch {
    return false;
  }
}

export function stemOf(rel: string): string {
  return rel.slice(0, rel.length - extname(rel).length);
}

/** A named method map, or one default handler for every method. */
export type ApiHandler = RouteHandler | Record<string, RouteHandler>;

export interface ApiFile {
  file: string;
  /** apiDir-relative, forward slashes (`users/[id].ts`). */
  rel: string;
  /** The Bun route paths this file serves, after collisions are resolved. */
  paths: string[];
}

export interface ApiRouteCollision {
  path: string;
  /** apiDir-relative file that served the route. */
  winner: string;
  /** apiDir-relative file that was shadowed. */
  loser: string;
}

/** `:id` and `:slug` are the same route to Bun, which silently keeps the last one registered. */
const routeKey = (path: string) => path.replace(/:[^/]+/g, ":");

/**
 * Route files under `apiDir`, without importing them. When two files map to
 * the same path, an optional catch-all (`[[...x]]`) gives up its parent path,
 * otherwise the first by name then extension (`a.ts` over `a.tsx`) wins, and
 * each loss is reported.
 */
export async function discoverApiFiles(
  apiDir: string,
): Promise<{ files: ApiFile[]; collisions: ApiRouteCollision[] }> {
  const entries = (await collectFiles(apiDir)).map((file) => {
    const rel = posixRelative(apiDir, file);
    return { file, rel, ...apiPaths(rel) };
  });
  entries.sort(
    (a, b) =>
      stemOf(a.rel).localeCompare(stemOf(b.rel), "en") ||
      ROUTE_EXTENSIONS.indexOf(extname(a.rel)) -
        ROUTE_EXTENSIONS.indexOf(extname(b.rel)),
  );

  const owners = new Map<
    string,
    { rel: string; path: string; optional: boolean }
  >();
  const collisions: ApiRouteCollision[] = [];
  for (const { rel, paths, optional } of entries) {
    for (const path of paths) {
      const key = routeKey(path);
      const current = owners.get(key);
      if (!current) {
        owners.set(key, { rel, path, optional });
      } else if (current.optional && !optional) {
        collisions.push({ path, winner: rel, loser: current.rel });
        owners.set(key, { rel, path, optional });
      } else {
        collisions.push({
          path: current.path,
          winner: current.rel,
          loser: rel,
        });
      }
    }
  }

  const files = entries
    .map(({ file, rel, paths }) => ({
      file,
      rel,
      paths: paths.filter((path) => owners.get(routeKey(path))?.rel === rel),
    }))
    .filter((entry) => entry.paths.length > 0);
  return { files, collisions };
}

export interface ApiRoute {
  path: string;
  /** apiDir-relative file that owns the path. */
  file: string;
  handler?: ApiHandler;
  websocket?: WebSocketRouteHandlers;
}

/** Imports the files that own a route (concurrently) and returns one entry per path they serve. */
export async function loadApiRoutes(
  apiDir: string,
): Promise<{ routes: ApiRoute[]; collisions: ApiRouteCollision[] }> {
  const { files, collisions } = await discoverApiFiles(apiDir);
  const mods = await Promise.all(
    files.map((f) => import(f.file) as Promise<Record<string, unknown>>),
  );

  const routes: ApiRoute[] = [];
  files.forEach(({ rel, paths }, i) => {
    const mod = mods[i]!;
    const handler = handlerFromModule(mod);
    const websocket = isWebSocketRouteHandlers(mod.websocket)
      ? mod.websocket
      : undefined;
    if ("websocket" in mod && !websocket) {
      console.warn(
        `[steambun] ${rel}: \`websocket\` export has no open/message/close handler, so it is not served`,
      );
    } else if (!handler && !websocket) {
      console.warn(
        `[steambun] ${rel}: no route exports (expected GET/POST/..., a default function, or \`websocket\`), so it is not served`,
      );
    }
    for (const path of paths) {
      if (handler || websocket)
        routes.push({ path, file: rel, handler, websocket });
    }
  });
  return { routes, collisions };
}
