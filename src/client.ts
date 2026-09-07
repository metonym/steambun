export class SteambunApiError extends Error {
  status: number;
  body: unknown;

  constructor(method: string, path: string, status: number, body: unknown) {
    super(`steambun api error: ${method} ${path} → ${status}`);
    this.name = "SteambunApiError";
    this.status = status;
    this.body = body;
  }
}

function substituteParams(
  path: string,
  params?: Record<string, string>,
): string {
  if (!params) return path;
  return path.replace(/:([^/]+)/g, (segment, name: string) =>
    name in params ? encodeURIComponent(params[name]!) : segment,
  );
}

// A plain member-expression chain (no `?.`/fallback) so both Bun's
// build-time `define` and the dev-mode textual substitution — which matches
// "import.meta.env.BASE_URL" verbatim — can replace it. Like Vite,
// import.meta.env only resolves inside a bundled/dev-served module.
function withBase(path: string): string {
  const base: string = import.meta.env.BASE_URL;
  if (base === "/" || !path.startsWith("/")) return path;
  return `${base.replace(/\/$/, "")}${path}`;
}

export interface ApiOptions {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  init?: RequestInit;
}

/**
 * Typed fetch against a file-based API route — see `steambun/client`'s
 * ambient types for the generic signature checked against
 * `.steambun/routes.d.ts`.
 */
export async function api(
  method: string,
  path: string,
  opts: ApiOptions = {},
): Promise<unknown> {
  let resolved = substituteParams(path, opts.params);
  if (opts.query) {
    const qs = new URLSearchParams(opts.query).toString();
    if (qs) resolved += `${resolved.includes("?") ? "&" : "?"}${qs}`;
  }

  const headers = new Headers(opts.init?.headers);
  let body = opts.init?.body;
  if (opts.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(withBase(resolved), {
    ...opts.init,
    method: method.toUpperCase(),
    headers,
    body,
  });

  if (!res.ok) {
    let errorBody: unknown;
    try {
      errorBody = await res.clone().json();
    } catch {
      errorBody = await res.text().catch(() => undefined);
    }
    throw new SteambunApiError(
      method.toUpperCase(),
      resolved,
      res.status,
      errorBody,
    );
  }

  if (res.status === 204 || res.status === 205) return undefined;
  const text = await res.text();
  if (text === "") return undefined;
  const contentType = res.headers.get("content-type") ?? "";
  return contentType.includes("json") ? JSON.parse(text) : text;
}

/** Typed link builder — substitutes `:param` segments and prefixes `import.meta.env.BASE_URL`. */
export function href(path: string, params?: Record<string, string>): string {
  return withBase(substituteParams(path, params));
}
