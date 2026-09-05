import { relative } from "node:path";
import type { ResolvedConfig } from "../config/types";
import { loadApiRoutes } from "./api-routes";
import { composeServerMiddleware, createErrorHandler } from "./http";
import type { Middleware, RouteHandler } from "./middleware";
import { withMiddleware } from "./middleware";
import { createProxyRouteHandler, createProxyWebSocketHandlers } from "./proxy";
import { addPublicDirRoutes } from "./public-dir";
import { createStaticHandler } from "./static";

const HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
]);

export interface AppRoutes {
  [path: string]: unknown;
}

export interface CreateAppOptions {
  config: ResolvedConfig;
  mode: "dev" | "preview";
  /** dev: HTML bundle imports keyed by serve path; preview: undefined */
  htmlRoutes?: Record<string, unknown>;
  /** preview/compile: built output dir */
  outDir?: string;
  /** preview/compile: api dir override (compiled binaries resolve by basename) */
  apiDir?: string;
}

export interface RouteRow {
  path: string;
  kind: "html" | "public" | "api" | "proxy" | "ws" | "static";
  methods: string[];
  source: string;
}

export interface App {
  routes: AppRoutes;
  middleware: Middleware[];
  /** Everything except port/hostname/tls: routes, error, idleTimeout, websocket, development */
  serveOptions: Omit<
    Bun.Serve.Options<unknown>,
    "port" | "hostname" | "tls" | "fetch"
  >;
  /** In-process dispatch through the same routes, no socket. */
  fetch(req: Request): Promise<Response>;
  /** Table rows for `steambun routes` and startup logging. */
  routeTable(): RouteRow[];
}

function fileNameOf(value: unknown): string {
  if (value && typeof value === "object" && "name" in value) {
    const name = (value as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "";
}

function staticPrefixLength(path: string): number {
  const idx = path.search(/[:*]/);
  return idx === -1 ? path.length : idx;
}

function matchPattern(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  const params: Record<string, string> = {};

  for (let i = 0; i < patternParts.length; i++) {
    const part = patternParts[i]!;
    if (part === "*") {
      params["*"] = pathParts.slice(i).join("/");
      return params;
    }
    if (part.startsWith(":")) {
      if (i >= pathParts.length) return null;
      params[part.slice(1)] = pathParts[i]!;
      continue;
    }
    if (pathParts[i] !== part) return null;
  }
  return patternParts.length === pathParts.length ? params : null;
}

function matchRoute(
  routes: AppRoutes,
  pathname: string,
): { value: unknown; params?: Record<string, string> } | null {
  if (pathname in routes) return { value: routes[pathname] };

  const candidates = Object.keys(routes).filter(
    (path) => path.includes(":") || path.endsWith("*"),
  );
  candidates.sort((a, b) => {
    const aWildcard = a.endsWith("*");
    const bWildcard = b.endsWith("*");
    if (aWildcard !== bWildcard) return aWildcard ? 1 : -1;
    return staticPrefixLength(b) - staticPrefixLength(a);
  });

  for (const path of candidates) {
    const params = matchPattern(path, pathname);
    if (params) return { value: routes[path], params };
  }
  return null;
}

function isMethodMap(value: object): value is Record<string, unknown> {
  return Object.keys(value).some((key) => HTTP_METHODS.has(key));
}

async function dispatch(
  value: unknown,
  req: Request,
  params?: Record<string, string>,
): Promise<Response> {
  if (params) Object.assign(req, { params });

  if (typeof value === "function") {
    const res = await (value as RouteHandler)(req);
    return res ?? new Response(null, { status: 200 });
  }
  if (value instanceof Blob) {
    return new Response(value);
  }
  if (value && typeof value === "object" && isMethodMap(value)) {
    const fn = value[req.method];
    if (typeof fn === "function") {
      const res = await (fn as RouteHandler)(req);
      return res ?? new Response(null, { status: 200 });
    }
    return new Response("Method Not Allowed", { status: 405 });
  }
  // HTMLBundle, `{ dir }` routes, or anything else Bun.serve accepts natively.
  return new Response("", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

const ROUTE_TABLE_INLINE_LIMIT = 40;

/** Prints `app.routeTable()` inline, or a count above `ROUTE_TABLE_INLINE_LIMIT`. */
export function printRouteTable(rows: RouteRow[]): void {
  if (rows.length === 0) return;
  if (rows.length > ROUTE_TABLE_INLINE_LIMIT) {
    console.log(
      `[steambun] ${rows.length} routes registered. Run \`steambun routes\` to list them.`,
    );
    return;
  }
  console.log(Bun.inspect.table(rows));
}

export async function createApp(opts: CreateAppOptions): Promise<App> {
  const { config, mode } = opts;
  const middleware = composeServerMiddleware(
    config.server ?? {},
    config.middleware,
  );
  const routes: AppRoutes = {};
  const rows: RouteRow[] = [];

  if (mode === "dev" && opts.htmlRoutes) {
    for (const [path, mod] of Object.entries(opts.htmlRoutes)) {
      routes[path] = mod;
      rows.push({ path, kind: "html", methods: ["*"], source: "" });
    }
  }

  if (config.publicDir) {
    const before = new Set(Object.keys(routes));
    await addPublicDirRoutes(routes, config.publicDir);
    for (const path of Object.keys(routes)) {
      if (before.has(path)) continue;
      rows.push({
        path,
        kind: "public",
        methods: ["GET"],
        source: relative(config.root, fileNameOf(routes[path])),
      });
    }
  }

  let hasWsProxy = false;
  for (const [prefix, entry] of Object.entries(config.server?.proxy ?? {})) {
    const handler = withMiddleware(
      middleware,
      createProxyRouteHandler(prefix, entry) as unknown as RouteHandler,
    );
    const wildcard = prefix.endsWith("/") ? `${prefix}*` : `${prefix}/*`;
    routes[prefix] = handler;
    routes[wildcard] = handler;
    const target = typeof entry === "string" ? entry : entry.target;
    rows.push({ path: prefix, kind: "proxy", methods: ["*"], source: target });
    rows.push({
      path: wildcard,
      kind: "proxy",
      methods: ["*"],
      source: target,
    });
    if (typeof entry === "object" && entry.ws) hasWsProxy = true;
  }

  const apiDir = opts.apiDir ?? config.api;
  if (apiDir) {
    const apiRoutes = await loadApiRoutes(apiDir);
    const source = relative(config.root, apiDir);
    for (const [path, handler] of Object.entries(apiRoutes)) {
      if (typeof handler === "function") {
        routes[path] = withMiddleware(middleware, handler as RouteHandler);
        rows.push({ path, kind: "api", methods: ["*"], source });
      } else {
        const wrapped: Record<string, unknown> = {};
        const methods: string[] = [];
        for (const [method, fn] of Object.entries(
          handler as Record<string, unknown>,
        )) {
          wrapped[method] = withMiddleware(middleware, fn as RouteHandler);
          methods.push(method);
        }
        routes[path] = wrapped;
        rows.push({ path, kind: "api", methods, source });
      }
    }
  }

  if (mode === "preview") {
    const outDir = opts.outDir;
    if (!outDir) {
      throw new Error("[steambun] createApp preview mode requires outDir");
    }
    // A single static handler covers assets, publicDir copies, and the SPA
    // fallback — including inside a compiled binary's embedded $bunfs
    // filesystem, which the native `{ dir }` route can't open (see
    // prod-server.ts). immutablePrefix gives hashed assetsDir files
    // long-lived caching without a separate route.
    routes["/*"] = withMiddleware(
      middleware,
      createStaticHandler({
        outDir,
        spa: config.appType === "spa",
        immutablePrefix: `/${config.build.assetsDir}/`,
        precompressed: config.build.precompress !== false,
      }),
    );
    rows.push({
      path: "/*",
      kind: "static",
      methods: ["*"],
      source: outDir,
    });
  }

  const serveOptions = {
    routes,
    error: createErrorHandler(mode === "dev"),
    idleTimeout: config.server.idleTimeout,
    maxRequestBodySize: config.server.maxRequestBodySize,
    ...(hasWsProxy ? { websocket: createProxyWebSocketHandlers() } : {}),
    ...(mode === "dev"
      ? { development: { hmr: true, console: true }, id: "steambun-dev" }
      : {}),
  } as unknown as App["serveOptions"];

  return {
    routes,
    middleware,
    serveOptions,
    async fetch(req: Request): Promise<Response> {
      const pathname = new URL(req.url).pathname;
      const matched = matchRoute(routes, pathname);
      if (!matched) return new Response("Not Found", { status: 404 });
      return dispatch(matched.value, req, matched.params);
    },
    routeTable(): RouteRow[] {
      return [...rows].sort((a, b) => a.path.localeCompare(b.path));
    },
  };
}
