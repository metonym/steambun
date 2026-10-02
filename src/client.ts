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
  const resolved = path.replace(/\/:([^/?#]+)/g, (segment, name: string) =>
    params && name in params
      ? `/${encodeURIComponent(params[name]!)}`
      : segment,
  );
  const missing = resolved.match(/\/:([^/?#]+)/);
  if (missing) {
    throw new Error(
      `steambun: missing value for ":${missing[1]}" in "${path}"`,
    );
  }
  return resolved;
}

/** Shared by `api`, `href`, and `ws`. */
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

// Must stay a plain `import.meta.env.BASE_URL` chain: both Bun's `define` and dev-mode substitution match it verbatim.
function withBase(path: string): string {
  const base: string = import.meta.env.BASE_URL;
  if (base === "/" || !path.startsWith("/")) return path;
  return `${base.replace(/\/$/, "")}${path}`;
}

// Consumers see the generic versions of these in client.d.ts.
interface ApiOptions {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  init?: RequestInit;
}

export async function api(
  method: string,
  path: string,
  opts: ApiOptions = {},
): Promise<unknown> {
  const resolved = buildPath(path, opts.params, opts.query);
  const verb = method.toUpperCase();

  const headers = new Headers(opts.init?.headers);
  let body = opts.init?.body;
  if (opts.body !== undefined) {
    if (!headers.has("content-type"))
      headers.set("content-type", "application/json");
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(withBase(resolved), {
    ...opts.init,
    method: verb,
    headers,
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => undefined);
    let errorBody: unknown = text;
    try {
      errorBody = JSON.parse(text ?? "");
    } catch {
      // not JSON: keep the raw text
    }
    throw new SteambunApiError(verb, resolved, res.status, errorBody);
  }

  const text = await res.text();
  if (!text) return undefined;
  return res.headers.get("content-type")?.includes("json")
    ? JSON.parse(text)
    : text;
}

export function href(
  path: string,
  opts: Pick<WsOptions, "params" | "query"> = {},
): string {
  return withBase(buildPath(path, opts.params, opts.query));
}

interface WsOptions {
  params?: Record<string, string>;
  query?: Record<string, string | string[]>;
  protocols?: string | string[];
  reconnect?: boolean | { maxAttempts?: number; baseDelayMs?: number };
}

interface SteambunSocket {
  readonly socket: WebSocket;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  on(
    event: "open" | "message" | "close" | "error",
    fn: (ev: Event) => void,
  ): () => void;
}

function toWsUrl(path: string): string {
  const url = new URL(path, location.href);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  return url.toString();
}

/** Reconnect backs off exponentially from `baseDelayMs`, capped at 30s; `close()` stops it for good. `send()` throws while a reconnect is pending. */
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
  let reconnectPending = false;
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
      reconnectPending = true;
      setTimeout(
        () => {
          reconnectPending = false;
          if (!userClosed) socket = connect();
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
    send: (data) => {
      if (reconnectPending) {
        throw new Error("steambun: ws send() while a reconnect is pending");
      }
      socket.send(data as never);
    },
    close: (code, reason) => {
      userClosed = true;
      socket.close(code, reason);
    },
    on: (event, fn) => {
      const list = listeners[event] ?? [];
      listeners[event] = list;
      list.push(fn);
      return () => {
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      };
    },
  };
}
