import type { HttpsOptions } from "../config/types";
import { devCertPaths } from "../util/dev-cert";
import { resolveFrom } from "../util/paths";
import type { Middleware, RouteHandler, ServerLike } from "./middleware";

const CORS_ALLOW_METHODS = "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS";
const CORS_ALLOW_HEADERS = "Content-Type, Authorization";

/** Every JSON error body steambun produces has this shape: `{ error, ...detail }`. */
export function errorResponse(
  status: number,
  error: string,
  detail?: Record<string, unknown>,
): Response {
  return Response.json({ error, ...detail }, { status });
}

export function isWebSocketUpgrade(req: Request): boolean {
  return req.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/** `undefined` once upgraded, a 500 otherwise. */
export function upgradeOrFail(
  req: Request,
  server: ServerLike | undefined,
  data: unknown,
): Response | undefined {
  return server?.upgrade(req, { data })
    ? undefined
    : errorResponse(500, "WebSocket upgrade failed");
}

/** Sets headers in place; falls back to cloning for an immutable `Response` (e.g. a raw `fetch()` result). */
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

function responseHeadersMiddleware(
  pairs: readonly [string, string][],
): Middleware {
  const apply = (res: Response | undefined) =>
    res ? withHeaders(res, pairs) : res;
  return (_req, next) => {
    const result = next();
    return result instanceof Promise ? result.then(apply) : apply(result);
  };
}

/**
 * Permissive CORS middleware: allows all origins and answers `OPTIONS`
 * preflight requests directly, echoing the requested headers.
 */
export function corsMiddleware(): Middleware {
  const addHeaders = responseHeadersMiddleware([
    ["Access-Control-Allow-Origin", "*"],
  ]);
  return (req, next) => {
    if (req.method !== "OPTIONS") return addHeaders(req, next);
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
        "Access-Control-Allow-Headers":
          req.headers.get("access-control-request-headers") ||
          CORS_ALLOW_HEADERS,
        Vary: "Access-Control-Request-Headers",
      },
    });
  };
}

/** Adds static response headers to every request that reaches the handler. */
export function headersMiddleware(headers: Record<string, string>): Middleware {
  return responseHeadersMiddleware(Object.entries(headers));
}

/** `server.cors` and `server.headers` first, then the user's `middleware` array. */
export function composeServerMiddleware(
  server: {
    cors?: boolean;
    headers?: Record<string, string>;
  },
  userMiddleware: unknown[] | undefined,
): Middleware[] {
  const chain: Middleware[] = [];
  if (server.cors) chain.push(corsMiddleware());
  if (server.headers) chain.push(headersMiddleware(server.headers));
  userMiddleware?.forEach((item, i) => {
    if (typeof item !== "function") {
      throw new Error(`[steambun] middleware[${i}] must be a function`);
    }
    chain.push(item as Middleware);
  });
  return chain;
}

/** Vite-shaped `server.https` (file paths) → `Bun.serve({ tls })` (file handles). */
export function tlsFromHttps(
  https: HttpsOptions | true | undefined,
  root: string,
  opts: { devCert?: boolean } = {},
): Bun.TLSOptions | undefined {
  if (!https) return undefined;
  if (https === true) {
    if (!opts.devCert) {
      console.warn(
        "[steambun] server.https: true is a local dev certificate for `dev` and `preview` only — serving plain HTTP. Set server.https to { key, cert } for TLS here.",
      );
      return undefined;
    }
    const paths = devCertPaths(root);
    return { key: Bun.file(paths.key), cert: Bun.file(paths.cert) };
  }
  const resolve = (path: string) => resolveFrom(root, path);
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

/** `Bun.serve({ error })` handler: logs, then returns a generic 500 unless `dev` (Bun's own overlay shows it). */
export function createErrorHandler(dev: boolean) {
  return function error(err: unknown) {
    console.error(err);
    if (dev) return;
    return errorResponse(500, "Internal Server Error");
  };
}

/**
 * Dev-only: turns a thrown error into a 500 whose JSON body carries the stack.
 * Bun's `error` hook never sees throws from inside route handlers.
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
      return errorResponse(500, error.message, {
        stack: error.stack,
        method: req.method,
        path: pathname,
        route,
      });
    }
  };
}

function isAddrInUse(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "EADDRINUSE";
}

/**
 * `Bun.serve` with Vite-style port retry: on `EADDRINUSE`, tries `port + 1`
 * until `attempts` ports (default 10) have been tried, unless `strictPort` is set.
 */
export function serveWithPortRetry<
  WebSocketData = undefined,
  R extends string = never,
>(
  options: Bun.Serve.Options<WebSocketData, R> & { port: number },
  opts: { strictPort?: boolean; attempts?: number; label?: string },
): Bun.Server<WebSocketData> {
  const { strictPort = false, attempts = 10, label } = opts;
  const firstPort = options.port;
  for (let attempt = 0; ; attempt++) {
    const port = firstPort + attempt;
    try {
      return Bun.serve({ ...options, port });
    } catch (err) {
      if (!isAddrInUse(err)) throw err;
      if (strictPort) {
        throw new Error(
          `[steambun] port ${port} is already in use (strictPort)`,
        );
      }
      if (attempt + 1 >= attempts) {
        throw new Error(
          `[steambun] no free port in ${firstPort}-${port} (${attempt + 1} tried)`,
        );
      }
      console.warn(
        `[steambun] ${label ? `${label} ` : ""}port ${port} is in use, trying ${port + 1}`,
      );
    }
  }
}
