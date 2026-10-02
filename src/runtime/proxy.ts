import type { ProxyEntry, ProxyOptions } from "../config/types";
import { errorResponse, isWebSocketUpgrade, upgradeOrFail } from "./http";
import type { RouteHandler, ServerLike } from "./middleware";

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function stripHopByHopHeaders(headers: Headers): void {
  // `Connection` also names the headers that are hop-by-hop for this connection.
  for (const token of headers.get("connection")?.split(",") ?? []) {
    const name = token.trim();
    if (name) headers.delete(name);
  }
  for (const name of HOP_BY_HOP_HEADERS) {
    if (headers.has(name)) headers.delete(name);
  }
}

export interface ProxyWebSocketData {
  proxyTarget: string;
  upstream?: WebSocket;
  /** Messages received while the upstream is still CONNECTING (sending then throws). */
  queue?: (string | Uint8Array)[];
}

/**
 * Request handler for one `server.proxy` entry. With `ws: true`, an upgrade
 * request is handed to `server.upgrade` and served by
 * {@link proxyWebSocket}.
 *
 * @example
 * ```ts
 * const routes = {
 *   "/api-legacy/*": createProxyRouteHandler("/api-legacy", "http://localhost:8080"),
 * };
 * ```
 */
export function createProxyRouteHandler(
  prefix: string,
  entry: ProxyEntry,
): RouteHandler {
  const opts: ProxyOptions =
    typeof entry === "string" ? { target: entry } : entry;
  const targetBase = new URL(opts.target);
  const targetPrefix = targetBase.pathname.replace(/\/+$/, "");

  const prefixDir = prefix.endsWith("/") ? prefix : `${prefix}/`;

  function resolveTargetUrl(req: Request): { target: URL; reqUrl: URL } | null {
    const reqUrl = new URL(req.url);
    // Bun routes by the raw path, but `req.url` is normalized: `/api/%2e%2e/x` arrives as `/x`.
    if (reqUrl.pathname !== prefix && !reqUrl.pathname.startsWith(prefixDir)) {
      return null;
    }
    let path = reqUrl.pathname.slice(prefix.length) || "/";
    if (opts.rewrite) path = opts.rewrite(path);
    // Joined like http-proxy: the target's own path prefix stays in front.
    const target = new URL(targetBase);
    target.pathname = targetPrefix + (path.startsWith("/") ? path : `/${path}`);
    target.search = reqUrl.search;
    return { target, reqUrl };
  }

  let loggedUnreachable = false;

  return (
    req: Request,
    server?: ServerLike,
  ): Response | Promise<Response> | undefined => {
    const resolved = resolveTargetUrl(req);
    if (!resolved) return errorResponse(404, "Not Found");
    const { target, reqUrl } = resolved;

    if (opts.ws && isWebSocketUpgrade(req)) {
      const targetUrl = new URL(target);
      targetUrl.protocol = targetUrl.protocol === "https:" ? "wss:" : "ws:";
      const data: ProxyWebSocketData = { proxyTarget: targetUrl.toString() };
      return upgradeOrFail(req, server, data);
    }

    const headers = new Headers(req.headers);
    if (opts.changeOrigin) {
      headers.set("host", target.host);
      headers.set("origin", target.origin);
      if (!headers.has("x-forwarded-proto")) {
        headers.set("x-forwarded-proto", reqUrl.protocol.slice(0, -1));
      }
      if (!headers.has("x-forwarded-host")) {
        headers.set("x-forwarded-host", reqUrl.host);
      }
      if (!headers.has("x-forwarded-for")) {
        const address = server?.requestIP?.(req)?.address;
        if (address) headers.set("x-forwarded-for", address);
      }
    }
    stripHopByHopHeaders(headers);

    const init: RequestInit = {
      method: req.method,
      headers,
      body: req.body,
      redirect: "manual",
      // Keep the body encoded: fetch() would otherwise decode it but leave `content-encoding` set.
      decompress: false,
    } as RequestInit;
    if (req.body) (init as { duplex?: string }).duplex = "half";

    return fetch(target, init).then(
      (res) => {
        const responseHeaders = new Headers(res.headers);
        stripHopByHopHeaders(responseHeaders);
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers: responseHeaders,
        });
      },
      () => {
        if (!loggedUnreachable) {
          loggedUnreachable = true;
          console.error(`[steambun] proxy target unreachable: ${opts.target}`);
        }
        return errorResponse(502, "proxy target unreachable", {
          target: opts.target,
        });
      },
    );
  };
}

interface ProxyServerWebSocket {
  data: ProxyWebSocketData;
  send: (data: string | ArrayBuffer | Uint8Array) => void;
  close: () => void;
}

/** `websocket` handlers that pipe a connection to `ws.data.proxyTarget`; shared with file-based routes in `serverWebSocket`. */
export const proxyWebSocket = {
  open(ws: ProxyServerWebSocket) {
    const upstream = new WebSocket(ws.data.proxyTarget);
    upstream.binaryType = "arraybuffer";
    const queue: (string | Uint8Array)[] = [];
    ws.data.queue = queue;
    upstream.onopen = () => {
      for (const message of queue) upstream.send(message as string);
      queue.length = 0;
    };
    upstream.onmessage = (event) => ws.send(event.data as string | ArrayBuffer);
    upstream.onclose = () => ws.close();
    ws.data.upstream = upstream;
  },
  message(ws: ProxyServerWebSocket, message: string | Uint8Array) {
    const upstream = ws.data.upstream;
    if (!upstream) return;
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(message as string);
    } else {
      ws.data.queue?.push(message);
    }
  },
  close(ws: ProxyServerWebSocket) {
    ws.data.upstream?.close();
  },
};
