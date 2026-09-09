import type { ProxyEntry, ProxyOptions } from "../config/types";
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

/**
 * Deletes the hop-by-hop headers that are present. Eight `has()` probes beat
 * copying `headers.keys()` into an array, and deleting while iterating the
 * live iterator would skip entries.
 */
function stripHopByHopHeaders(headers: Headers): void {
  for (const name of HOP_BY_HOP_HEADERS) {
    if (headers.has(name)) headers.delete(name);
  }
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
export function createProxyRouteHandler(
  prefix: string,
  entry: ProxyEntry,
): RouteHandler {
  const opts = normalize(entry);
  const targetBase = new URL(opts.target);

  function resolveTargetUrl(req: Request): { target: URL; reqUrl: URL } {
    const reqUrl = new URL(req.url);
    let path = reqUrl.pathname.slice(prefix.length) || "/";
    if (opts.rewrite) path = opts.rewrite(path);
    return { target: new URL(path + reqUrl.search, targetBase), reqUrl };
  }

  let loggedUnreachable = false;

  return (
    req: Request,
    server?: ServerLike,
  ): Response | Promise<Response> | undefined => {
    if (opts.ws && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const { target: targetUrl } = resolveTargetUrl(req);
      targetUrl.protocol = targetUrl.protocol === "https:" ? "wss:" : "ws:";
      const data: ProxyWebSocketData = { proxyTarget: targetUrl.toString() };
      const upgraded = server?.upgrade(req, { data });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    const { target, reqUrl } = resolveTargetUrl(req);
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
    };
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
        return Response.json(
          { error: "proxy target unreachable", target: opts.target },
          { status: 502 },
        );
      },
    );
  };
}

interface ProxyServerWebSocket {
  data: ProxyWebSocketData;
  send: (data: string | ArrayBuffer | Uint8Array) => void;
  close: () => void;
}

/**
 * `Bun.serve` `websocket` handlers that pipe a proxied connection to its
 * upstream target (set on `ws.data.proxyTarget` by `server.upgrade(req, { data })`).
 * Internal — {@link createWsRouter} in `ws-routes.ts` merges this in with
 * file-based WebSocket routes into the single `websocket` handler
 * `Bun.serve` allows.
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
