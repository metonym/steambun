import { errorResponse, isWebSocketUpgrade, upgradeOrFail } from "./http";
import type { RouteHandler } from "./middleware";
import type { ProxyWebSocketData } from "./proxy";
import { proxyWebSocket } from "./proxy";

export interface WsRouteData {
  /** The route path as registered (`/api/chat/:room`). */
  route: string;
  params: Record<string, string>;
}

export type WebSocketRouteHandlers = Bun.WebSocketHandler<WsRouteData>;

/** Resolved at upgrade time so each event skips a lookup. */
type RouteSocketData = WsRouteData & { handlers: WebSocketRouteHandlers };

type SocketData = RouteSocketData | ProxyWebSocketData;

const target = (ws: Bun.ServerWebSocket<SocketData>) =>
  "handlers" in ws.data ? ws.data.handlers : proxyWebSocket;

/** The one `websocket` handler `Bun.serve` allows: file-based routes and `server.proxy` pass-through share it. */
export const serverWebSocket: Bun.WebSocketHandler<SocketData> = {
  open: (ws) => target(ws).open?.(ws as never),
  message: (ws, message) => target(ws).message?.(ws as never, message as never),
  close: (ws, code, reason) => target(ws).close?.(ws as never, code, reason),
};

/** Upgrades a WebSocket request to `handlers`; anything else goes to `fallback`, or `426` without one. */
export function withWebSocketUpgrade(
  route: string,
  handlers: WebSocketRouteHandlers,
  fallback?: RouteHandler,
): RouteHandler {
  return (req, server) => {
    if (!isWebSocketUpgrade(req)) {
      return fallback
        ? fallback(req, server)
        : errorResponse(426, "Upgrade Required");
    }
    const data: RouteSocketData = {
      route,
      params:
        (req as Request & { params?: Record<string, string> }).params ?? {},
      handlers,
    };
    return upgradeOrFail(req, server, data);
  };
}
