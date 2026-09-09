export type NextFn = () => Response | Promise<Response | undefined> | undefined;
export type Middleware = (
  req: Request,
  next: NextFn,
) => Response | Promise<Response | undefined> | undefined;

/**
 * Structural subset of `Bun.Server` that route, proxy, and WebSocket-upgrade
 * handlers need — lets those modules take `server` typed instead of
 * `unknown`/`as never`.
 */
export interface ServerLike {
  upgrade(req: Request, opts?: { data?: unknown }): boolean;
  requestIP?(req: Request): { address: string } | null;
  timeout?(req: Request, seconds: number): void;
}

export type RouteHandler = (
  req: Request,
  server?: ServerLike,
) => Response | Promise<Response | undefined> | undefined;

/**
 * Applies to API routes and proxy entries; Bun's native HTML/asset routes
 * aren't covered — see oven-sh/bun#17608. `server` is forwarded to the inner
 * handler so proxy WebSocket upgrades can call server.upgrade.
 *
 * @example
 * ```ts
 * import { withMiddleware, corsMiddleware } from "steambun/runtime";
 *
 * const handler = withMiddleware(
 *   [corsMiddleware(), async (req, next) => (console.log(req.url), next())],
 *   () => Response.json({ ok: true }),
 * );
 * ```
 */
export function withMiddleware(
  middleware: Middleware[],
  handler: RouteHandler,
): RouteHandler {
  if (middleware.length === 0) return handler;

  return (req, server) => {
    let index = -1;
    const next = (): Response | Promise<Response | undefined> | undefined => {
      if (++index > middleware.length) {
        throw new Error("next() called multiple times");
      }
      if (index === middleware.length) return handler(req, server);
      return middleware[index]!(req, next);
    };
    return next();
  };
}
