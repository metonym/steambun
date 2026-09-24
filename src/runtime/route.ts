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

function parseQuery(url: string): RouteQuery {
  const query: RouteQuery = {};
  for (const [key, value] of new URL(url).searchParams) {
    const existing = query[key];
    if (existing === undefined) query[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else query[key] = [existing, value];
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
      const existing = form[key];
      if (existing === undefined) form[key] = value;
      else if (Array.isArray(existing)) existing.push(value);
      else form[key] = [existing, value];
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
  return async (req, server) => {
    const issues: RouteValidationIssue[] = [];
    const check = async (
      where: RouteValidationIssue["in"],
      raw: unknown,
    ): Promise<unknown> => {
      const schema = schemas[where];
      if (!schema) return raw;
      const result = await validateWith(schema, raw);
      if (result.ok) return result.value;
      for (const issue of result.issues) issues.push({ in: where, ...issue });
      return undefined;
    };

    const params = await check("params", req.params);
    const query = await check("query", parseQuery(req.url));
    let body: unknown;
    if (schemas.body) {
      let raw: unknown;
      try {
        raw = await parseBody(req);
      } catch (error) {
        if (!(error instanceof InvalidBody)) throw error;
        issues.push({ in: "body", path: "", message: "Invalid JSON" });
      }
      if (issues.every((issue) => issue.in !== "body")) {
        body = await check("body", raw);
      }
    }
    if (issues.length > 0) {
      return Response.json(
        { error: "invalid request", issues },
        { status: 400 },
      );
    }

    const value = await fn({ req, params, query, body, server });
    return value instanceof Response ? value : Response.json(value);
  };
}
