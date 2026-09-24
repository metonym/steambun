import {
  type StandardSchemaV1,
  type ValidationIssue,
  validateWith,
} from "../util/standard-schema";

/** Repeated keys (`?tag=a&tag=b`) become arrays. */
export type RouteQuery = Record<string, string | string[]>;

export interface RouteContext<P, Q = RouteQuery, B = undefined> {
  req: Request;
  params: P;
  query: Q;
  /** The validated body. `undefined` unless `route()` was given a `body` schema. */
  body: B;
  server: unknown;
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

type RouteHandler<P, R, I> = ((
  req: Request & { params: P },
  server?: unknown,
) => Promise<Response>) & {
  __steambun_return?: R;
  __steambun_input?: I;
};

// Each overload narrows the context differently; the implementation only
// forwards it.
// biome-ignore lint/suspicious/noExplicitAny: see above
type AnyRouteFn = (ctx: RouteContext<any, any, any>) => unknown;

/** Where a failed schema check came from, alongside its issues. */
export interface RouteValidationIssue extends ValidationIssue {
  in: "params" | "query" | "body";
}

function addValue(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  const existing = target[key];
  if (existing === undefined) target[key] = value;
  else if (Array.isArray(existing)) existing.push(value);
  else target[key] = [existing, value];
}

// Same result as URLSearchParams ("+" is a space, percent-escapes decode,
// malformed ones are kept), about 2x faster on typical API queries: most
// keys and values need no decoding at all.
function decodeQueryPart(part: string): string {
  if (part.indexOf("%") === -1 && part.indexOf("+") === -1) return part;
  try {
    return decodeURIComponent(part.replace(/\+/g, " "));
  } catch {
    return new URLSearchParams(`x=${part}`).get("x") ?? part;
  }
}

// Only the search string, not a full `new URL()` parse: request URLs carry
// no fragment, so everything after the first "?" is the query.
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
    for (const [key, value] of await req.formData()) {
      addValue(form, key, value);
    }
    return form;
  }
  const text = await req.text();
  if (type && !type.includes("json")) return text;
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidBody();
  }
}

/**
 * Wraps a handler so its return value becomes `Response.json(value)`
 * (unless it's already a `Response`), and its declared return type carries
 * the original value type via a phantom `__steambun_return` property so
 * `steambun/client`'s `api()` can infer it. Without `route()`, `api()`'s
 * return type falls back to `unknown` for a route returning a bare `Response`.
 *
 * Pass [Standard Schema](https://standardschema.dev) validators (zod,
 * valibot, arktype, ...) first to validate `params`, `query`, and `body`
 * before the handler runs. A failure returns `400` with
 * `{ error: "invalid request", issues: [{ in, path, message }] }`; the
 * schemas' input types also flow to `api()`'s `body` and `query` options.
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
): RouteHandler<P, R, { query?: Record<string, string>; body?: unknown }>;
export function route<S extends RouteSchemas, R>(
  schemas: S,
  fn: (
    ctx: RouteContext<
      OutputOr<S["params"], Record<string, string>>,
      OutputOr<S["query"], RouteQuery>,
      OutputOr<S["body"], undefined>
    >,
  ) => R | Promise<R>,
): RouteHandler<
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
  server?: unknown,
) => Promise<Response> {
  const schemas = typeof schemasOrFn === "function" ? {} : schemasOrFn;
  const fn = typeof schemasOrFn === "function" ? schemasOrFn : maybeFn!;
  if (!schemas.params && !schemas.query && !schemas.body) {
    // The common case: no validation state to set up per request.
    return async (req, server) => {
      const value = await fn(
        new LazyQueryContext(req, req.params, undefined, server),
      );
      return value instanceof Response ? value : Response.json(value);
    };
  }
  return async (req, server) => {
    let issues: RouteValidationIssue[] | undefined;
    const check = async (
      where: RouteValidationIssue["in"],
      schema: StandardSchemaV1,
      raw: unknown,
    ): Promise<unknown> => {
      const result = await validateWith(schema, raw);
      if (result.ok) return result.value;
      issues ??= [];
      for (const issue of result.issues) issues.push({ in: where, ...issue });
      return undefined;
    };

    const params = schemas.params
      ? await check("params", schemas.params, req.params)
      : req.params;
    const query = schemas.query
      ? await check("query", schemas.query, parseQuery(req.url))
      : undefined;
    let body: unknown;
    if (schemas.body) {
      let raw: unknown;
      let parsed = true;
      try {
        raw = await parseBody(req);
      } catch (error) {
        if (!(error instanceof InvalidBody)) throw error;
        parsed = false;
        issues ??= [];
        issues.push({ in: "body", path: "", message: "Invalid JSON" });
      }
      if (parsed) body = await check("body", schemas.body, raw);
    }
    if (issues) {
      return Response.json(
        { error: "invalid request", issues },
        { status: 400 },
      );
    }

    const ctx = schemas.query
      ? { req, params, query, body, server }
      : new LazyQueryContext(req, params, body, server);
    const value = await fn(ctx);
    return value instanceof Response ? value : Response.json(value);
  };
}

/** A handler that never reads `query` never pays to parse it. A class keeps
 * the getter on the prototype, so each request only allocates the fields. */
class LazyQueryContext implements RouteContext<unknown, RouteQuery, unknown> {
  #query: RouteQuery | undefined;
  constructor(
    readonly req: Request,
    readonly params: unknown,
    readonly body: unknown,
    readonly server: unknown,
  ) {}
  get query(): RouteQuery {
    this.#query ??= parseQuery(this.req.url);
    return this.#query;
  }
}
