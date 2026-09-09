import { join, relative, sep } from "node:path";
import type { ResolvedConfig } from "../config/types";
import { splitPlugins } from "../util/plugins";
import type { ApiRouteCollision } from "./api-routes";
import { loadApiModules } from "./api-routes";
import {
  composeServerMiddleware,
  createErrorHandler,
  wrapDevErrors,
} from "./http";
import type { Middleware, RouteHandler } from "./middleware";
import { withMiddleware } from "./middleware";
import { createProxyRouteHandler } from "./proxy";
import { addPublicDirRoutes } from "./public-dir";
import { createStaticHandler } from "./static";
import { createWsRouter } from "./ws-routes";

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
  /**
   * Dispatches through a real, lazily started `Bun.serve` instance bound to
   * `app.routes` — a genuine round trip through Bun's own router (params,
   * method maps, 405s, HTML/static routes), not a hand-rolled matcher.
   */
  fetch(req: Request): Promise<Response>;
  /** Stops the server `fetch()` may have started. No-op if `fetch()` was never called. */
  close(): void;
  [Symbol.asyncDispose](): Promise<void>;
  /** Table rows for `steambun routes` and startup logging. */
  routeTable(): RouteRow[];
  /** API routes shadowed by a more specific file mapping to the same path. */
  readonly collisions: ApiRouteCollision[];
}

export function formatApiRouteCollision(
  collision: ApiRouteCollision,
  source: string,
): string {
  return `[steambun] api route collision: ${collision.path} ← ${source}/${collision.winner} (used) and ${source}/${collision.loser} (ignored)`;
}

/** SSE responses should never hit Bun's idle timeout — disable it per-request. */
function withSseTimeout(handler: RouteHandler): RouteHandler {
  return (req, server) => {
    const timeout = server?.timeout;
    if (typeof timeout !== "function") return handler(req, server);

    const result = handler(req, server);
    const tag = (res: Response | undefined) => {
      if (res?.headers.get("content-type")?.includes("text/event-stream")) {
        timeout.call(server, req, 0);
      }
      return res;
    };
    return result instanceof Promise ? result.then(tag) : tag(result);
  };
}

export async function createApp(opts: CreateAppOptions): Promise<App> {
  const { config, mode } = opts;
  const middleware = composeServerMiddleware(
    config.server ?? {},
    config.middleware,
  );
  const routes: AppRoutes = {};
  const rows: RouteRow[] = [];

  /** The steambun-standard handler stack, in the same order everywhere it's applied. */
  const wrap = (fn: RouteHandler, label: string): RouteHandler =>
    withMiddleware(
      middleware,
      mode === "dev"
        ? wrapDevErrors(withSseTimeout(fn), label)
        : withSseTimeout(fn),
    );

  if (mode === "dev" && opts.htmlRoutes) {
    for (const [path, mod] of Object.entries(opts.htmlRoutes)) {
      routes[path] = mod;
      rows.push({ path, kind: "html", methods: ["*"], source: "" });
    }
  }

  if (config.publicDir) {
    const publicDir = config.publicDir;
    const before = new Set(Object.keys(routes));
    await addPublicDirRoutes(routes, publicDir);
    for (const path of Object.keys(routes)) {
      if (before.has(path)) continue;
      // Undo addPublicDirRoutes' percent-encoding to recover the file's path
      // relative to publicDir, without inspecting the routed value itself.
      const rel = path.slice(1).split("/").map(decodeURIComponent).join(sep);
      rows.push({
        path,
        kind: "public",
        methods: ["GET"],
        source: relative(config.root, join(publicDir, rel)),
      });
    }
  }

  let hasWsProxy = false;
  for (const [prefix, entry] of Object.entries(config.server?.proxy ?? {})) {
    const target = typeof entry === "string" ? entry : entry.target;
    const handler = wrap(
      createProxyRouteHandler(prefix, entry),
      `proxy ${prefix} -> ${target}`,
    );
    const wildcard = prefix.endsWith("/") ? `${prefix}*` : `${prefix}/*`;
    routes[prefix] = handler;
    routes[wildcard] = handler;
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
  const apiModules = apiDir ? await loadApiModules(apiDir) : undefined;
  const websockets = apiModules?.websockets ?? new Map();
  const wsRouter = createWsRouter(websockets);

  if (apiDir && apiModules) {
    const apiRoutes = apiModules.routes;
    const source = relative(config.root, apiDir);
    const routeLabel = (path: string) =>
      join(source, apiModules.fileForPath.get(path) ?? "");

    for (const collision of apiModules.collisions) {
      console.log(formatApiRouteCollision(collision, source));
    }
    const paths = new Set([...Object.keys(apiRoutes), ...websockets.keys()]);

    for (const path of paths) {
      const handler = apiRoutes[path];
      const upgrade = websockets.has(path)
        ? wsRouter.upgradeHandler(path)
        : undefined;

      if (upgrade) {
        const fallback: RouteHandler =
          typeof handler === "function"
            ? (handler as RouteHandler)
            : handler
              ? (req, server) => {
                  const fn = (handler as Record<string, unknown>)[req.method];
                  return typeof fn === "function"
                    ? (fn as RouteHandler)(req, server)
                    : new Response("Method Not Allowed", { status: 405 });
                }
              : () => new Response("Upgrade Required", { status: 426 });
        const combined: RouteHandler = (req, server) => {
          if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
            return upgrade(req, server);
          }
          return fallback(req, server);
        };
        routes[path] = wrap(combined, routeLabel(path));
        const methods =
          handler && typeof handler === "object" ? Object.keys(handler) : ["*"];
        rows.push({ path, kind: "ws", methods, source });
        continue;
      }

      if (typeof handler === "function") {
        routes[path] = wrap(handler as RouteHandler, routeLabel(path));
        rows.push({ path, kind: "api", methods: ["*"], source });
      } else {
        const wrapped: Record<string, unknown> = {};
        const methods: string[] = [];
        for (const [method, handlerFn] of Object.entries(
          handler as Record<string, unknown>,
        )) {
          wrapped[method] = wrap(handlerFn as RouteHandler, routeLabel(path));
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
        headersFile: join(outDir, "_headers.json"),
        chunkMapFile: join(outDir, ".steambun-chunks.json"),
        base: config.base,
      }),
    );
    rows.push({
      path: "/*",
      kind: "static",
      methods: ["*"],
      source: outDir,
    });
  }

  // Lazily started by `fetch()` — most callers only ever use `serveOptions`
  // with their own `Bun.serve`, so `createApp` itself never opens a socket.
  let server: Bun.Server<unknown> | undefined;

  const app: App = {
    routes,
    middleware,
    collisions: apiModules?.collisions ?? [],
    // Placeholder — computed below from app.routes/app.middleware after
    // configureApp hooks run, so a hook that adds a route sees it served.
    serveOptions: {} as App["serveOptions"],
    async fetch(req: Request): Promise<Response> {
      server ??= Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        ...app.serveOptions,
      } as Bun.Serve.Options<unknown>);

      const url = new URL(req.url);
      const target = new URL(url.pathname + url.search + url.hash, server.url);
      const init: RequestInit = {
        method: req.method,
        headers: req.headers,
        body: req.body,
        redirect: "manual",
        // Return exactly what the route produced — fetch() otherwise
        // transparently decodes a compressed body while leaving
        // `content-encoding` on the response, which would desync the two.
        decompress: false,
      } as RequestInit;
      if (req.body) (init as { duplex?: string }).duplex = "half";
      return fetch(target, init);
    },
    close(): void {
      server?.stop(true);
      server = undefined;
    },
    async [Symbol.asyncDispose](): Promise<void> {
      app.close();
    },
    routeTable(): RouteRow[] {
      return [...rows].sort((a, b) => a.path.localeCompare(b.path));
    },
  };

  const { hooks } = splitPlugins(config.plugins ?? []);
  for (const hook of hooks) {
    if (hook.configureApp) await hook.configureApp(app, { mode });
  }

  app.serveOptions = {
    routes: app.routes,
    error: createErrorHandler(mode === "dev"),
    idleTimeout: config.server.idleTimeout,
    maxRequestBodySize: config.server.maxRequestBodySize,
    ...(hasWsProxy || websockets.size > 0
      ? { websocket: wsRouter.websocket }
      : {}),
    ...(mode === "dev"
      ? { development: { hmr: true, console: true }, id: "steambun-dev" }
      : {}),
  } as unknown as App["serveOptions"];

  return app;
}
