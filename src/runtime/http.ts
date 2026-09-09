import { isAbsolute, join } from "node:path";
import type { HttpsOptions } from "../config/types";
import type { Middleware, RouteHandler } from "./middleware";

const CORS_ALLOW_METHODS = "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS";
const CORS_ALLOW_HEADERS = "Content-Type, Authorization";

/**
 * Sets `pairs` on `res.headers` in place — no allocation on the common case,
 * where a route/proxy response has mutable headers. Falls back to Bun's
 * clone-and-set for the rare immutable `Response` (e.g. one returned
 * directly from a raw `fetch()`).
 */
function withHeaders(
  res: Response,
  pairs: readonly [string, string][],
): Response {
  try {
    for (const [key, value] of pairs) res.headers.set(key, value);
    return res;
  } catch {
    const out = new Response(res.body, res);
    for (const [key, value] of pairs) out.headers.set(key, value);
    return out;
  }
}

/**
 * Permissive CORS middleware: allows all origins, answers `OPTIONS` preflight
 * requests directly, and adds CORS headers to every other response.
 *
 * @example
 * ```ts
 * import { corsMiddleware, withMiddleware } from "steambun/runtime";
 *
 * const handler = withMiddleware([corsMiddleware()], (req) => Response.json({ ok: true }));
 * ```
 */
export function corsMiddleware(): Middleware {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
  };
  const pairs = Object.entries(corsHeaders) as [string, string][];
  const preflightHeaders = new Headers(corsHeaders);
  return (req, next) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: preflightHeaders });
    }
    const apply = (res: Response | undefined) =>
      res ? withHeaders(res, pairs) : res;
    const result = next();
    return result instanceof Promise ? result.then(apply) : apply(result);
  };
}

/**
 * Adds static response headers to every request that reaches the handler.
 *
 * @example
 * ```ts
 * headersMiddleware({ "x-powered-by": "steambun" });
 * ```
 */
export function headersMiddleware(headers: Record<string, string>): Middleware {
  const pairs = Object.entries(headers) as [string, string][];
  return (_req, next) => {
    const apply = (res: Response | undefined) =>
      res ? withHeaders(res, pairs) : res;
    const result = next();
    return result instanceof Promise ? result.then(apply) : apply(result);
  };
}

/**
 * Builds the middleware chain steambun runs for every request: `server.cors`
 * and `server.headers` first, then the user's `middleware` array.
 *
 * @example
 * ```ts
 * const chain = composeServerMiddleware({ cors: true }, config.middleware);
 * const handler = withMiddleware(chain, apiHandler);
 * ```
 */
export function composeServerMiddleware(
  server: {
    cors?: boolean;
    headers?: Record<string, string>;
  },
  userMiddleware: unknown[] | undefined,
): Middleware[] {
  const extra: Middleware[] = [];
  if (server.cors) extra.push(corsMiddleware());
  if (server.headers) extra.push(headersMiddleware(server.headers));
  for (const item of userMiddleware ?? []) {
    if (typeof item === "function") extra.push(item as Middleware);
  }
  return extra;
}

/**
 * Vite-shaped `server.https` (file paths) → `Bun.serve({ tls })` (file handles).
 *
 * @example
 * ```ts
 * const tls = tlsFromHttps({ key: "key.pem", cert: "cert.pem" }, process.cwd());
 * Bun.serve({ tls, fetch: () => new Response("ok") });
 * ```
 */
export function tlsFromHttps(
  https: HttpsOptions | undefined,
  root: string,
): Bun.TLSOptions | undefined {
  if (!https) return undefined;
  const resolve = (path: string) =>
    isAbsolute(path) ? path : join(root, path);
  const ca = https.ca
    ? Array.isArray(https.ca)
      ? https.ca.map((path) => Bun.file(resolve(path)))
      : Bun.file(resolve(https.ca))
    : undefined;
  return {
    key: Bun.file(resolve(https.key)),
    cert: Bun.file(resolve(https.cert)),
    ...(ca ? { ca } : {}),
    ...(https.passphrase ? { passphrase: https.passphrase } : {}),
  };
}

/**
 * `Bun.serve({ error })` handler: logs the error, and in production hides
 * details behind a generic 500 (dev mode lets Bun's own overlay show it).
 *
 * @example
 * ```ts
 * Bun.serve({ error: createErrorHandler(false), fetch });
 * ```
 */
export function createErrorHandler(dev: boolean) {
  return function error(err: unknown) {
    console.error(err);
    if (dev) return;
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function devErrorHtml(error: Error, route: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>steambun dev error</title></head>
<body>
<div role="alertdialog" aria-modal="true" style="font-family: monospace; padding: 1.5rem; max-width: 60rem;">
  <button aria-label="Close" onclick="this.closest('[role=alertdialog]').remove()" style="float: right;">&times;</button>
  <h1 style="color: #e5484d;">${escapeHtml(error.message)}</h1>
  <p>${escapeHtml(route)}</p>
  <pre style="white-space: pre-wrap;">${escapeHtml(error.stack ?? "")}</pre>
</div>
</body>
</html>`;
}

/**
 * Dev-only: wraps a `RouteHandler` so a thrown error becomes a visible 500
 * (JSON, or an HTML alert dialog for a browser navigation) instead of the
 * silent failure `createErrorHandler`'s dev branch leaves behind — Bun's own
 * `error` hook never sees a throw from inside a route/proxy/middleware
 * function, only from its own dispatch.
 *
 * @example
 * ```ts
 * routes[path] = wrapDevErrors(handler, "api/users/[id].ts");
 * ```
 */
export function wrapDevErrors(
  handler: RouteHandler,
  route: string,
): RouteHandler {
  return async (req, server) => {
    try {
      return await handler(req, server);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const pathname = new URL(req.url).pathname;
      console.error(
        `[steambun] ${req.method} ${pathname} threw: ${error.message} (${route})`,
      );
      if (req.headers.get("accept")?.includes("text/html")) {
        return new Response(devErrorHtml(error, route), {
          status: 500,
          headers: { "content-type": "text/html" },
        });
      }
      return Response.json(
        {
          error: error.message,
          stack: error.stack,
          method: req.method,
          path: pathname,
          route,
        },
        { status: 500 },
      );
    }
  };
}

function isAddrInUseError(err: unknown): err is Error & { code: string } {
  return (
    err instanceof Error && (err as { code?: string }).code === "EADDRINUSE"
  );
}

/**
 * `Bun.serve` with Vite-style port retry: on `EADDRINUSE`, tries `port + 1`
 * up to `attempts` times (default 10), unless `strictPort` is set, in which
 * case it fails immediately with a clear message. `port: 0` (pick any free
 * port) is passed through without retry.
 *
 * @example
 * ```ts
 * const server = serveWithPortRetry({ port: 5173, fetch }, { label: "dev" });
 * ```
 */
export function serveWithPortRetry<
  WebSocketData = undefined,
  R extends string = never,
>(
  options: Bun.Serve.Options<WebSocketData, R> & { port: number },
  opts: { strictPort?: boolean; attempts?: number; label?: string },
): Bun.Server<WebSocketData> {
  const { strictPort = false, attempts = 10, label } = opts;
  if (options.port === 0) return Bun.serve(options);

  let port = options.port;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return Bun.serve({ ...options, port });
    } catch (err) {
      if (!isAddrInUseError(err)) throw err;
      if (strictPort) {
        throw new Error(
          `[steambun] port ${port} is already in use (strictPort)`,
        );
      }
      const nextPort = port + 1;
      console.warn(
        `[steambun] ${label ? `${label} ` : ""}port ${port} is in use, trying ${nextPort}`,
      );
      port = nextPort;
    }
  }
  return Bun.serve({ ...options, port });
}
