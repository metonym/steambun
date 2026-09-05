export interface RouteContext<P> {
  req: Request;
  params: P;
  server: unknown;
}

/**
 * Wraps a handler so its return value becomes `Response.json(value)`
 * (unless it's already a `Response`), and its declared return type carries
 * the original value type via a phantom `__steambun_return` property so
 * `steambun/client`'s `api()` can infer it. Without `route()`, `api()`'s
 * return type falls back to `unknown` for a route returning a bare `Response`.
 *
 * @example
 * ```ts
 * // src/api/users/[id].ts
 * import { route } from "steambun/runtime";
 *
 * export const GET = route(({ params }) => ({ id: params.id }));
 * ```
 */
export function route<P extends Record<string, string>, R>(
  fn: (ctx: RouteContext<P>) => R | Promise<R>,
): ((req: Request & { params: P }, server?: unknown) => Promise<Response>) & {
  __steambun_return?: R;
} {
  return async (req: Request & { params: P }, server?: unknown) => {
    const value = await fn({ req, params: req.params, server });
    return value instanceof Response ? value : Response.json(value);
  };
}
