declare global {
  interface ImportMetaEnv {
    readonly MODE: string;
    readonly DEV: boolean;
    readonly PROD: boolean;
    readonly SSR: boolean;
    readonly BASE_URL: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

/** Augmented per-project by the generated `.steambun/routes.d.ts`. */
// biome-ignore lint/suspicious/noEmptyInterface: augmented via declaration merging
export interface SteambunRoutes {}
/** Augmented per-project by the generated `.steambun/routes.d.ts`. */
// biome-ignore lint/suspicious/noEmptyInterface: augmented via declaration merging
export interface SteambunPages {}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

// `route()`'s wrapper always returns `Promise<Response>` at the type level —
// its real value type only survives via the phantom `__steambun_return`
// property, so that's checked (and unwrapped from its `| undefined`) before
// falling back to a plain handler's actual return type.
type ReturnOf<H> = "__steambun_return" extends keyof H
  ? NonNullable<H["__steambun_return"]>
  : // biome-ignore lint/suspicious/noExplicitAny: matches handlers of any arity/arg types
    H extends (...args: any[]) => infer R
    ? R
    : never;

type HandlerOf<M, K extends Method> =
  M extends Record<K, infer H>
    ? ReturnOf<H>
    : M extends { default: infer H }
      ? ReturnOf<H>
      : never;

/** `Response` → `unknown` (body shape unknown without parsing); anything else (e.g. via `route()`) passes through. */
type Json<R> = Awaited<R> extends Response ? unknown : Awaited<R>;

export interface ApiOptions<P> {
  params?: P;
  query?: Record<string, string>;
  body?: unknown;
  init?: RequestInit;
}

export class SteambunApiError extends Error {
  status: number;
  body: unknown;
  constructor(method: string, path: string, status: number, body: unknown);
}

/**
 * Typed fetch against a file-based API route. `path` and `params` are
 * checked against the generated `.steambun/routes.d.ts`; the resolved
 * type is the matching method handler's return value (via {@link Json}),
 * or `unknown` if the handler returns a bare `Response`.
 */
type ParamsOf<P extends keyof SteambunRoutes> = SteambunRoutes[P] extends {
  params: infer Params;
}
  ? Params
  : never;
type ModuleOf<P extends keyof SteambunRoutes> = SteambunRoutes[P] extends {
  module: infer M;
}
  ? M
  : never;
type ApiReturn<P extends keyof SteambunRoutes, K extends Method> = Json<
  HandlerOf<ModuleOf<P>, K>
>;

export function api<
  P extends keyof SteambunRoutes,
  K extends Lowercase<Method>,
>(
  method: K,
  path: P,
  opts?: ApiOptions<ParamsOf<P>>,
): Promise<ApiReturn<P, Uppercase<K>>>;

/** Typed link builder for a page or API route path, substituting any `:param` segments. */
export function href<P extends keyof SteambunPages | keyof SteambunRoutes>(
  path: P,
  ...args: P extends keyof SteambunRoutes
    ? SteambunRoutes[P] extends { params: infer Params }
      ? keyof Params extends never
        ? []
        : [params: Params]
      : []
    : []
): string;
