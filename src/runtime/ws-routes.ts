import type { RouteHandler } from "./middleware";
import type { ProxyWebSocketData } from "./proxy";
import { createProxyWebSocketHandlers } from "./proxy";

export interface WsRouteData {
  route: string;
  params: Record<string, string>;
  user?: unknown;
  /** Resolved once at upgrade time so `message`/`open`/`close` skip the `Map.get` per event. */
  handlers?: WebSocketRouteHandlers;
}

export type WebSocketRouteHandlers = Bun.WebSocketHandler<WsRouteData>;

function isRouteData(data: unknown): data is WsRouteData {
  return !!data && typeof data === "object" && "route" in data;
}

/**
 * Merges file-based WebSocket route handlers with the proxy's WebSocket
 * pass-through into the single `websocket` handler `Bun.serve` allows, and
 * builds the per-route upgrade handler that decides route into that merge.
 *
 * @example
 * ```ts
 * import { createWsRouter } from "steambun/runtime";
 *
 * const { upgradeHandler, websocket } = createWsRouter(websockets);
 * Bun.serve({
 *   routes: { "/api/chat/:room": upgradeHandler("/api/chat/:room") },
 *   websocket,
 * });
 * ```
 */
export function createWsRouter(handlers: Map<string, WebSocketRouteHandlers>): {
  upgradeHandler(routePath: string): RouteHandler;
  websocket: Bun.WebSocketHandler<WsRouteData | ProxyWebSocketData>;
} {
  const proxy = createProxyWebSocketHandlers();

  /** The handlers for this socket: file-route handlers resolved at upgrade time, or the proxy pass-through. */
  const target = (ws: Bun.ServerWebSocket<WsRouteData | ProxyWebSocketData>) =>
    isRouteData(ws.data) ? ws.data.handlers : proxy;

  const websocket: Bun.WebSocketHandler<WsRouteData | ProxyWebSocketData> = {
    open: (ws) => target(ws)?.open?.(ws as never),
    message: (ws, message) =>
      target(ws)?.message?.(ws as never, message as never),
    close: (ws, code, reason) => target(ws)?.close?.(ws as never, code, reason),
  };

  function upgradeHandler(routePath: string): RouteHandler {
    return (req, server) => {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Upgrade Required", { status: 426 });
      }
      const params =
        (req as Request & { params?: Record<string, string> }).params ?? {};
      const data: WsRouteData = {
        route: routePath,
        params,
        handlers: handlers.get(routePath),
      };
      const upgraded = server?.upgrade(req, { data });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    };
  }

  return { upgradeHandler, websocket };
}
