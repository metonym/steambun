import {
  type StandardSchemaV1,
  type ValidationIssue,
  validateWith,
} from "../util/standard-schema";
import { errorResponse } from "./http";

/** Repeated keys (`?tag=a&tag=b`) become arrays. */
export type RouteQuery = Record<string, string | string[]>;

export interface RouteContext<P, Q = RouteQuery, B = undefined> {
  req: Request;
  params: P;
  query: Q;
  /** The validated body. `undefined` unless `route()` was given a `body` schema. */
  body: B;
  server: Bun.Server<unknown>;
}

export interface RouteSchemas {
  params?: StandardSchemaV1;
  query?: StandardSchemaV1;
  body?: StandardSchemaV1;
}

type OutputOr<S, Fallback> = S extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<S>
  : Fallback;
type InputOr<S, Fallback> = S extends StandardSchemaV1
  ? StandardSchemaV1.InferInput<S>
  : Fallback;

type RouteFn<P, R, I> = ((
  req: Request & { params: P },
  server?: Bun.Server<unknown>,
) => Promise<Response>) & {
  __steambun_return?: R;
  __steambun_input?: I;
};

// biome-ignore lint/suspicious/noExplicitAny: each overload narrows the context differently
type AnyRouteFn = (ctx: RouteContext<any, any, any>) => unknown;

/** A schema issue tagged with the request part it came from. */
interface RouteValidationIssue extends ValidationIssue {
  in: "params" | "query" | "body";
}

function addValue(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  // Own keys only: `?constructor=a` must not see `Object.prototype.constructor`.
  const existing = Object.hasOwn(target, key) ? target[key] : undefined;
  if (existing === undefined) {
    // Plain assignment of `__proto__` would set the prototype instead of a key.
    if (key === "__proto__") {
      Object.defineProperty(target, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } else target[key] = value;
  } else if (Array.isArray(existing)) existing.push(value);
  else target[key] = [existing, value];
}

// Same result as URLSearchParams, ~2x faster on typical queries (most parts need no decoding).
function decodeQueryPart(part: string): string {
  if (part.indexOf("%") === -1 && part.indexOf("+") === -1) return part;
  try {
    return decodeURIComponent(part.replace(/\+/g, " "));
  } catch {
    return new URLSearchParams(`x=${part}`).get("x") ?? part;
  }
}

// Skips a full `new URL()` parse: request URLs carry no fragment, so everything after "?" is the query.
function parseQuery(url: string): RouteQuery {
  const query: RouteQuery = {};
  const start = url.indexOf("?");
  if (start === -1) return query;
  for (let i = start + 1; i <= url.length; ) {
    let end = url.indexOf("&", i);
    if (end === -1) end = url.length;
    if (end > i) {
      const eq = url.indexOf("=", i);
      const keyEnd = eq === -1 || eq > end ? end : eq;
      addValue(
        query,
        decodeQueryPart(url.slice(i, keyEnd)),
        keyEnd === end ? "" : decodeQueryPart(url.slice(keyEnd + 1, end)),
      );
    }
    i = end + 1;
  }
  return query;
}

class InvalidBody extends Error {}

async function parseBody(req: Request): Promise<unknown> {
  const type = req.headers.get("content-type") ?? "";
  if (
    type.includes("application/x-www-form-urlencoded") ||
    type.includes("multipart/form-data")
  ) {
    const form: Record<string, unknown> = {};
    try {
      for (const [key, value] of await req.formData()) {
        addValue(form, key, value);
      }
    } catch {
      throw new InvalidBody("Invalid form data");
    }
    return form;
  }
  const text = await req.text();
  if (text === "") return undefined;
  if (type && !type.includes("json")) return text;
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidBody("Invalid JSON");
  }
}

async function check(
  issues: RouteValidationIssue[],
  where: RouteValidationIssue["in"],
  schema: StandardSchemaV1,
  raw: unknown,
): Promise<unknown> {
  const result = await validateWith(schema, raw);
  if (result.ok) return result.value;
  for (const issue of result.issues) issues.push({ in: where, ...issue });
  return undefined;
}

function toResponse(value: unknown): Response {
  if (value instanceof Response) return value;
  return value === undefined
    ? new Response(null, { status: 204 })
    : Response.json(value);
}

/**
 * Wraps a handler so its return value becomes `Response.json(value)` (`204` for
 * `undefined`, unchanged if already a `Response`) and its type reaches `steambun/client`'s `api()` via
 * phantom `__steambun_return`/`__steambun_input` properties.
 *
 * Optional first-argument [Standard Schema](https://standardschema.dev)
 * validators check `params`, `query`, and `body` before the handler runs; a
 * failure returns `400` with `{ error: "invalid request", issues: [{ in, path, message }] }`.
 *
 * @example
 * ```ts
 * // src/api/users/[id].ts
 * import { route } from "steambun/runtime";
 * import { z } from "zod";
 *
 * export const GET = route(({ params }) => ({ id: params.id }));
 *
 * export const PATCH = route(
 *   { body: z.object({ name: z.string().min(1) }) },
 *   ({ params, body }) => ({ id: params.id, name: body.name }),
 * );
 * ```
 */
export function route<P extends Record<string, string>, R>(
  fn: (ctx: RouteContext<P>) => R | Promise<R>,
): RouteFn<P, R, { query?: Record<string, string>; body?: unknown }>;
export function route<S extends RouteSchemas, R>(
  schemas: S,
  fn: (
    ctx: RouteContext<
      OutputOr<S["params"], Record<string, string>>,
      OutputOr<S["query"], RouteQuery>,
      OutputOr<S["body"], undefined>
    >,
  ) => R | Promise<R>,
): RouteFn<
  Record<string, string>,
  R,
  {
    query?: InputOr<S["query"], Record<string, string>>;
    body?: InputOr<S["body"], unknown>;
  }
>;
export function route(
  schemasOrFn: RouteSchemas | AnyRouteFn,
  maybeFn?: AnyRouteFn,
): (
  req: Request & { params: Record<string, string> },
  server?: Bun.Server<unknown>,
) => Promise<Response> {
  const schemas = typeof schemasOrFn === "function" ? {} : schemasOrFn;
  const fn = typeof schemasOrFn === "function" ? schemasOrFn : maybeFn!;
  if (!schemas.params && !schemas.query && !schemas.body) {
    return async (req, server) => {
      return toResponse(
        await fn(new LazyQueryContext(req, req.params, undefined, server!)),
      );
    };
  }
  return async (req, server) => {
    const issues: RouteValidationIssue[] = [];
    const params = schemas.params
      ? await check(issues, "params", schemas.params, req.params)
      : req.params;
    const query = schemas.query
      ? await check(issues, "query", schemas.query, parseQuery(req.url))
      : undefined;
    let body: unknown;
    if (schemas.body) {
      try {
        body = await check(issues, "body", schemas.body, await parseBody(req));
      } catch (error) {
        if (!(error instanceof InvalidBody)) throw error;
        issues.push({ in: "body", path: "", message: error.message });
      }
    }
    if (issues.length > 0) {
      return errorResponse(400, "invalid request", { issues });
    }

    const ctx = schemas.query
      ? { req, params, query, body, server: server! }
      : new LazyQueryContext(req, params, body, server!);
    return toResponse(await fn(ctx));
  };
}

/** Parses `query` only if the handler reads it; the prototype getter keeps per-request allocation to the fields. */
class LazyQueryContext implements RouteContext<unknown, RouteQuery, unknown> {
  #query: RouteQuery | undefined;
  constructor(
    readonly req: Request,
    readonly params: unknown,
    readonly body: unknown,
    readonly server: Bun.Server<unknown>,
  ) {}
  get query(): RouteQuery {
    this.#query ??= parseQuery(this.req.url);
    return this.#query;
  }
}
