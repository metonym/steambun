import type { ProxyEntry, ProxyOptions } from "../config/types";

interface BunServerLike {
  upgrade: (req: Request, opts?: { data?: unknown }) => boolean;
}

export interface ProxyWebSocketData {
  proxyTarget: string;
  upstream?: WebSocket;
  // Buffers messages that arrive before the upstream connection finishes
  // opening — sending while CONNECTING throws InvalidStateError.
  queue?: (string | Uint8Array)[];
}

function normalize(entry: ProxyEntry): ProxyOptions {
  return typeof entry === "string" ? { target: entry } : entry;
}

/**
 * HTTP request handler for one `server.proxy` entry (string target or full
 * `ProxyOptions`). WebSocket upgrades are handled separately — pair this with
 * {@link createProxyWebSocketHandlers} when `ws: true`.
 *
 * @example
 * ```ts
 * import { createProxyRouteHandler } from "steambun/runtime";
 *
 * const routes = {
 *   "/api-legacy/*": createProxyRouteHandler("/api-legacy", "http://localhost:8080"),
 * };
 * ```
 */
export function createProxyRouteHandler(prefix: string, entry: ProxyEntry) {
  const opts = normalize(entry);
  const targetBase = new URL(opts.target);

  function resolveTargetUrl(req: Request): URL {
    const url = new URL(req.url);
    let path = url.pathname.slice(prefix.length) || "/";
    if (opts.rewrite) path = opts.rewrite(path);
    return new URL(path + url.search, targetBase);
  }

  return (
    req: Request,
    server: BunServerLike,
  ): Response | Promise<Response> | undefined => {
    if (opts.ws && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const targetUrl = resolveTargetUrl(req);
      targetUrl.protocol = targetUrl.protocol === "https:" ? "wss:" : "ws:";
      const data: ProxyWebSocketData = { proxyTarget: targetUrl.toString() };
      const upgraded = server.upgrade(req, { data });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    const target = resolveTargetUrl(req);
    let headers: Headers = req.headers as Headers;
    if (opts.changeOrigin) {
      headers = new Headers(req.headers);
      headers.set("host", target.host);
      headers.set("origin", target.origin);
    }

    const init: RequestInit = {
      method: req.method,
      headers,
      body: req.body,
      redirect: "manual",
    };
    if (req.body) (init as { duplex?: string }).duplex = "half";

    return fetch(target, init);
  };
}

interface ProxyServerWebSocket {
  data: ProxyWebSocketData;
  send: (data: string | ArrayBuffer | Uint8Array) => void;
  close: () => void;
}

/**
 * Bun.serve `websocket` handlers that pipe a proxied connection to its
 * upstream target (set on `ws.data.proxyTarget` by `server.upgrade(req, { data })`).
 *
 * @example
 * ```ts
 * Bun.serve({
 *   routes: { "/ws/*": createProxyRouteHandler("/ws", { target: "http://localhost:8080", ws: true }) },
 *   websocket: createProxyWebSocketHandlers(),
 * });
 * ```
 */
export function createProxyWebSocketHandlers() {
  return {
    open(ws: ProxyServerWebSocket) {
      const upstream = new WebSocket(ws.data.proxyTarget);
      upstream.binaryType = "arraybuffer";
      const queue: (string | Uint8Array)[] = [];
      ws.data.queue = queue;
      upstream.onopen = () => {
        for (const message of queue) upstream.send(message as string);
        queue.length = 0;
      };
      upstream.onmessage = (event) =>
        ws.send(event.data as string | ArrayBuffer);
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
}
