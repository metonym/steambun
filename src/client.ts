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

/** Substitutes `:param` segments and appends a query string — shared by
 * `api`, `href`, and `ws`. */
function buildPath(
  path: string,
  params?: Record<string, string>,
  query?: Record<string, unknown>,
): string {
  let resolved = substituteParams(path, params);
  if (query) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== undefined) search.append(key, String(item));
      }
    }
    const qs = search.toString();
    if (qs) resolved += `${resolved.includes("?") ? "&" : "?"}${qs}`;
  }
  return resolved;
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

// Not exported: consumers always see the generic ApiOptions<P>/WsOptions<P>/
// SteambunSocket declared in client.d.ts (package.json's "./client" export
// maps `types` there, independent of this file's own exports) — exporting
// these non-generic copies too would just be a second, drifting definition
// with no reader.
interface ApiOptions {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
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
  const resolved = buildPath(path, opts.params, opts.query);

  const headers = new Headers(opts.init?.headers);
  let body = opts.init?.body;
  if (opts.body !== undefined) {
    if (!headers.has("content-type"))
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

/** Typed link builder — substitutes `:param` segments, appends a query string, and prefixes `import.meta.env.BASE_URL`. */
export function href(
  path: string,
  params?: Record<string, string>,
  query?: Record<string, string>,
): string {
  return withBase(buildPath(path, params, query));
}

// Not exported — see the comment on ApiOptions above.
interface WsOptions {
  params?: Record<string, string>;
  query?: Record<string, string>;
  protocols?: string | string[];
  reconnect?: boolean | { maxAttempts?: number; baseDelayMs?: number };
}

// Not exported — see the comment on ApiOptions above.
interface SteambunSocket {
  readonly socket: WebSocket;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  on(
    event: "open" | "message" | "close" | "error",
    fn: (ev: Event) => void,
  ): void;
}

function toWsUrl(path: string): string {
  const absolute = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(path)
    ? path
    : new URL(path, location.href).href;
  const url = new URL(absolute);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  return url.toString();
}

/**
 * Typed WebSocket client against a file-based `export const websocket`
 * route — see `steambun/client`'s ambient types for the generic signature
 * checked against `.steambun/routes.d.ts`. Reconnect uses capped
 * exponential backoff (`baseDelayMs * 2 ** attempts`, capped at 30s);
 * calling the returned `close()` sets a flag so a subsequent `close` event
 * never reconnects.
 */
export function ws(path: string, opts: WsOptions = {}): SteambunSocket {
  const url = toWsUrl(withBase(buildPath(path, opts.params, opts.query)));
  const reconnect = opts.reconnect;
  const maxAttempts =
    (typeof reconnect === "object" ? reconnect.maxAttempts : undefined) ?? 10;
  const baseDelayMs =
    (typeof reconnect === "object" ? reconnect.baseDelayMs : undefined) ?? 250;
  const listeners: Record<string, Array<(ev: Event) => void>> = {};
  const fanOut = (event: string, ev: Event) => {
    for (const fn of listeners[event] ?? []) fn(ev);
  };
  let socket: WebSocket;
  let attempts = 0;
  let userClosed = false;
  const connect = (): WebSocket => {
    const s = new WebSocket(url, opts.protocols);
    s.onopen = (ev) => {
      attempts = 0;
      fanOut("open", ev);
    };
    s.onmessage = (ev) => fanOut("message", ev);
    s.onerror = (ev) => fanOut("error", ev);
    s.onclose = (ev) => {
      fanOut("close", ev);
      if (userClosed || !reconnect || attempts >= maxAttempts) return;
      setTimeout(
        () => {
          socket = connect();
        },
        Math.min(baseDelayMs * 2 ** attempts++, 30_000),
      );
    };
    return s;
  };
  socket = connect();
  return {
    get socket() {
      return socket;
    },
    send: (data) => socket.send(data as never),
    close: (code, reason) => {
      userClosed = true;
      socket.close(code, reason);
    },
    on: (event, fn) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
    },
  };
}
