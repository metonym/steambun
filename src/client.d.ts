declare global {
  interface ImportMetaEnv {
    readonly MODE: string;
    readonly DEV: boolean;
    readonly PROD: boolean;
    readonly SSR: boolean;
    readonly BASE_URL: string;
  }

  interface ImportGlobOptions {
    /** Pick one named export (`"default"`, `"setup"`, ...) instead of the module namespace. */
    import?: string;
    /** Appended to each import specifier, e.g. `"?raw"` (needs `resolve.viteSuffixes`). */
    query?: string | Record<string, string | boolean>;
    /** Also match dotfiles and `node_modules`. Default `false`. */
    exhaustive?: boolean;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
    /** Vite's `import.meta.glob`, expanded at bundle time by steambun. */
    glob<M = Record<string, unknown>>(
      pattern: string | readonly string[],
      options?: ImportGlobOptions & { eager?: false },
    ): Record<string, () => Promise<M>>;
    glob<M = Record<string, unknown>>(
      pattern: string | readonly string[],
      options: ImportGlobOptions & { eager: true },
    ): Record<string, M>;
  }
}

type ResolvedConfigExport<C> = Awaited<
  // biome-ignore lint/suspicious/noExplicitAny: matches config functions of any signature
  C extends (...args: any[]) => infer R ? R : C>;
type SchemaOutput<S> = S extends {
  readonly "~standard": { readonly types?: infer T };
}
  ? NonNullable<T> extends { readonly output: infer O }
    ? O
    : never
  : never;

/**
 * The envPrefix-matched keys of a config's `envSchema` output. Used by the
 * generated `.steambun/env.d.ts` to type `import.meta.env`.
 */
export type PublicEnvOf<C, Prefix extends string> =
  ResolvedConfigExport<C> extends { envSchema?: infer S }
    ? {
        readonly [K in keyof SchemaOutput<S> as K extends `${Prefix}${string}`
          ? K
          : never]: SchemaOutput<S>[K];
      }
    : // biome-ignore lint/complexity/noBannedTypes: no schema, no keys
      {};

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

type DefaultInput = { query?: Record<string, string>; body?: unknown };

// `route(schemas, fn)` records its schemas' input types on a phantom
// `__steambun_input` property, the same way `__steambun_return` carries the
// output type.
type InputOf<H> = "__steambun_input" extends keyof H
  ? NonNullable<H["__steambun_input"]>
  : DefaultInput;

type HandlerInputOf<M, K extends Method> =
  M extends Record<K, infer H>
    ? InputOf<H>
    : M extends { default: infer H }
      ? InputOf<H>
      : DefaultInput;

export interface ApiOptions<
  P,
  I extends { query?: unknown; body?: unknown } = DefaultInput,
> {
  params?: P;
  /** Array values repeat the key; other values are stringified. */
  query?: I["query"];
  body?: I["body"];
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
  opts?: ApiOptions<
    ParamsOf<P>,
    HandlerInputOf<ModuleOf<P>, Uppercase<K> & Method>
  >,
): Promise<ApiReturn<P, Uppercase<K>>>;

/** Typed link builder for a page or API route path, substituting any `:param` segments and appending an optional query string. */
export function href<P extends keyof SteambunPages | keyof SteambunRoutes>(
  path: P,
  ...args: P extends keyof SteambunRoutes
    ? SteambunRoutes[P] extends { params: infer Params }
      ? keyof Params extends never
        ? [params?: undefined, query?: Record<string, string>]
        : [params: Params, query?: Record<string, string>]
      : [params?: undefined, query?: Record<string, string>]
    : [params?: undefined, query?: Record<string, string>]
): string;

export interface WsOptions<P> {
  params?: P;
  query?: Record<string, string>;
  protocols?: string | string[];
  reconnect?: boolean | { maxAttempts?: number; baseDelayMs?: number };
}

export interface SteambunSocket {
  readonly socket: WebSocket;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  on(
    event: "open" | "message" | "close" | "error",
    fn: (ev: Event) => void,
  ): void;
}

type WebSocketRoutes = {
  [P in keyof SteambunRoutes]: SteambunRoutes[P] extends { websocket: true }
    ? P
    : never;
}[keyof SteambunRoutes];

/**
 * Typed WebSocket client against a file-based `export const websocket`
 * route. `path` is checked against the generated `.steambun/routes.d.ts`
 * and must belong to a route that exports `websocket`.
 */
export function ws<P extends WebSocketRoutes>(
  path: P,
  opts?: WsOptions<ParamsOf<P>>,
): SteambunSocket;
