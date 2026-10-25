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

const routeHandlers = (ws: Bun.ServerWebSocket<SocketData>) =>
  "handlers" in ws.data ? ws.data.handlers : undefined;

const target = (ws: Bun.ServerWebSocket<SocketData>) =>
  routeHandlers(ws) ?? proxyWebSocket;

/** The one `websocket` handler `Bun.serve` allows: file-based routes and `server.proxy` pass-through share it. */
export const serverWebSocket: Bun.WebSocketHandler<SocketData> = {
  open: (ws) => target(ws).open?.(ws as never),
  message: (ws, message) => target(ws).message?.(ws as never, message as never),
  close: (ws, code, reason) => target(ws).close?.(ws as never, code, reason),
  drain: (ws) => routeHandlers(ws)?.drain?.(ws as never),
  ping: (ws, data) => routeHandlers(ws)?.ping?.(ws as never, data),
  pong: (ws, data) => routeHandlers(ws)?.pong?.(ws as never, data),
  error(error, ws) {
    const handler = routeHandlers(ws)?.error;
    // Rethrowing is what Bun does without an `error` handler: print it and keep the socket open.
    if (!handler) throw error;
    return handler(error, ws as never);
  },
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
