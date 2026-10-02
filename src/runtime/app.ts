import { join, relative } from "node:path";
import type { ResolvedConfig } from "../config/types";
import { DIST_SERVER_FILE } from "../util/paths";
import { splitPlugins } from "../util/plugins";
import type { ApiHandler, ApiRouteCollision } from "./api-routes";
import { API_PREFIX, isApiPath, loadApiRoutes, stemOf } from "./api-routes";
import {
  composeServerMiddleware,
  createErrorHandler,
  errorResponse,
  wrapDevErrors,
} from "./http";
import type { Middleware, RouteHandler } from "./middleware";
import { withMiddleware } from "./middleware";
import { createProxyRouteHandler } from "./proxy";
import { listPublicFiles } from "./public-dir";
import { createStaticHandler } from "./static";
import type { WebSocketRouteHandlers } from "./ws-routes";
import { serverWebSocket, withWebSocketUpgrade } from "./ws-routes";

export type CreateAppOptions = {
  config: ResolvedConfig;
  /** Overrides `config.api` (compiled binaries resolve it by basename). */
  apiDir?: string;
} & (
  | {
      mode: "dev";
      /** HTML bundle imports keyed by serve path. */
      htmlRoutes?: Record<string, unknown>;
    }
  | {
      mode: "preview";
      /** Built output dir. */
      outDir: string;
      /** Remember each path's resolved file. Default `true`; `steambun preview` sets `false` so a rebuild shows up. */
      cache?: boolean;
    }
);

export interface RouteRow {
  path: string;
  kind: "html" | "public" | "api" | "proxy" | "ws" | "static";
  methods: string[];
  source: string;
}

export interface App {
  routes: Record<string, unknown>;
  middleware: Middleware[];
  /** Everything `Bun.serve` needs except port/hostname/tls. */
  serveOptions: Omit<
    Bun.Serve.Options<unknown>,
    "port" | "hostname" | "tls" | "fetch"
  >;
  /** Dispatches through a lazily started `Bun.serve` on `app.routes`, so Bun's own router decides. */
  fetch(req: Request): Promise<Response>;
  /** Stops the server `fetch()` started, if any. */
  close(): void;
  /** Rows for `steambun routes` and startup logging. */
  routeTable(): RouteRow[];
  /** API files shadowed by a more specific (or earlier) file on the same path. */
  readonly collisions: ApiRouteCollision[];
}

function formatApiRouteCollision(
  collision: ApiRouteCollision,
  source: string,
): string {
  const note =
    stemOf(collision.winner) === stemOf(collision.loser)
      ? " — same file name with different extensions"
      : "";
  return `[steambun] api route collision: ${collision.path} ← ${source}/${collision.winner} (used) and ${source}/${collision.loser} (ignored)${note}`;
}

/** `text/event-stream` responses must not hit Bun's idle timeout. */
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

/** Upgrade requests reach `websocket`; everything else keeps the file's own HTTP handler (`GET` of a method map). */
function withWebSocket(
  path: string,
  websocket: WebSocketRouteHandlers,
  handler?: ApiHandler,
): ApiHandler {
  if (typeof handler === "object") {
    return {
      ...handler,
      GET: withWebSocketUpgrade(path, websocket, handler.GET),
    };
  }
  return withWebSocketUpgrade(path, websocket, handler);
}

export async function createApp(opts: CreateAppOptions): Promise<App> {
  const { config, mode } = opts;
  const middleware = composeServerMiddleware(config.server, config.middleware);
  const routes: Record<string, unknown> = {};
  const rows: RouteRow[] = [];
  const apiDir = opts.apiDir ?? config.api;

  const wrap = (fn: RouteHandler, label: string): RouteHandler => {
    const handler = withSseTimeout(fn);
    return withMiddleware(
      middleware,
      mode === "dev" ? wrapDevErrors(handler, label) : handler,
    );
  };

  if (opts.mode === "dev") {
    for (const [path, mod] of Object.entries(opts.htmlRoutes ?? {})) {
      routes[path] = mod;
      rows.push({ path, kind: "html", methods: ["*"], source: "" });
    }
  }

  // `preview` serves the copy `build` made in `outDir`.
  if (opts.mode === "dev" && config.publicDir) {
    for (const { urlPath, file } of await listPublicFiles(config.publicDir)) {
      if (urlPath in routes || (apiDir && isApiPath(urlPath))) continue;
      routes[urlPath] = Bun.file(file);
      rows.push({
        path: urlPath,
        kind: "public",
        methods: ["GET"],
        source: relative(config.root, file),
      });
    }
  }

  let hasWsProxy = false;
  for (const [prefix, entry] of Object.entries(config.server.proxy ?? {})) {
    const target = typeof entry === "string" ? entry : entry.target;
    const handler = wrap(
      createProxyRouteHandler(prefix, entry),
      `proxy ${prefix} -> ${target}`,
    );
    const wildcard = prefix.endsWith("/") ? `${prefix}*` : `${prefix}/*`;
    for (const path of [prefix, wildcard]) {
      routes[path] = handler;
      rows.push({ path, kind: "proxy", methods: ["*"], source: target });
    }
    if (typeof entry === "object" && entry.ws) hasWsProxy = true;
  }

  const api = apiDir ? await loadApiRoutes(apiDir) : undefined;
  let hasApiWebSocket = false;

  if (apiDir && api) {
    const source = relative(config.root, apiDir);
    for (const collision of api.collisions) {
      console.warn(formatApiRouteCollision(collision, source));
    }

    for (const { path, file, handler, websocket } of api.routes) {
      const label = join(source, file);
      const target = websocket
        ? withWebSocket(path, websocket, handler)
        : handler!;
      hasApiWebSocket ||= !!websocket;
      routes[path] =
        typeof target === "function"
          ? wrap(target, label)
          : Object.fromEntries(
              Object.entries(target).map(([method, fn]) => [
                method,
                wrap(fn, label),
              ]),
            );
      rows.push({
        path,
        kind: websocket ? "ws" : "api",
        methods: typeof target === "function" ? ["*"] : Object.keys(target),
        source,
      });
    }

    // An unmatched `/api` path is a JSON 404, never the SPA's index.html.
    const notFound = wrap(() => errorResponse(404, "Not Found"), "api 404");
    for (const path of [API_PREFIX, `${API_PREFIX}/*`])
      routes[path] ??= notFound;
  }

  if (opts.mode === "preview") {
    const { outDir } = opts;
    // Not Bun's native `{ dir }` route: it can't open a compiled binary's embedded $bunfs.
    routes["/*"] = createStaticHandler({
      outDir,
      spa: config.appType === "spa",
      immutablePrefix: `/${config.build.assetsDir}/`,
      precompressed: config.build.precompress !== false,
      base: config.base,
      cache: opts.cache,
      exclude:
        config.build.server && !config.build.standalone
          ? [DIST_SERVER_FILE]
          : [],
    });
    rows.push({ path: "/*", kind: "static", methods: ["*"], source: outDir });
  }

  // Started lazily: most callers only use `serveOptions` with their own `Bun.serve`.
  let server: Bun.Server<unknown> | undefined;

  const app: App = {
    routes,
    middleware,
    collisions: api?.collisions ?? [],
    // Filled in below, after `configureApp` hooks have had a chance to add routes.
    serveOptions: {} as App["serveOptions"],
    async fetch(req: Request): Promise<Response> {
      server ??= Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        ...app.serveOptions,
      } as Bun.Serve.Options<unknown>);

      const { pathname, search } = new URL(req.url);
      // Concatenated, not resolved: `new URL("//host/x", base)` would leave the app's server.
      return fetch(`${server.url.origin}${pathname}${search}`, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        redirect: "manual",
        // fetch() would otherwise decode the body but keep `content-encoding`.
        decompress: false,
        ...(req.body ? { duplex: "half" } : {}),
      } as RequestInit);
    },
    close(): void {
      server?.stop(true);
      server = undefined;
    },
    routeTable(): RouteRow[] {
      return [...rows].sort((a, b) => a.path.localeCompare(b.path));
    },
  };

  for (const hook of splitPlugins(config.plugins).hooks) {
    await hook.configureApp?.(app, { mode });
  }

  app.serveOptions = {
    routes: app.routes,
    error: createErrorHandler(mode === "dev"),
    idleTimeout: config.server.idleTimeout,
    maxRequestBodySize: config.server.maxRequestBodySize,
    ...(hasWsProxy || hasApiWebSocket ? { websocket: serverWebSocket } : {}),
    ...(mode === "dev"
      ? { development: { hmr: true, console: true }, id: "steambun-dev" }
      : {}),
  } as unknown as App["serveOptions"];

  return app;
}
