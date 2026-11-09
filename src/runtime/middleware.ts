type NextFn = () => Response | Promise<Response | undefined> | undefined;
export type Middleware = (
  req: Request,
  next: NextFn,
) => Response | Promise<Response | undefined> | undefined;

/** Structural subset of `Bun.Server` that route, proxy, and WebSocket-upgrade handlers use. */
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
 * aren't covered (oven-sh/bun#17608).
 *
 * @example
 * ```ts
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
    const run = (
      i: number,
    ): Response | Promise<Response | undefined> | undefined => {
      if (i === middleware.length) return handler(req, server);
      let called = false;
      return middleware[i]!(req, () => {
        if (called) throw new Error("next() called multiple times");
        called = true;
        return run(i + 1);
      });
    };
    return run(0);
  };
}
