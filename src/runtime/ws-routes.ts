import type { RouteHandler } from "./middleware";
import type { ProxyWebSocketData } from "./proxy";
import { createProxyWebSocketHandlers } from "./proxy";

export interface WsRouteData {
  route: string;
  params: Record<string, string>;
  user?: unknown;
}

export type WebSocketRouteHandlers = Bun.WebSocketHandler<WsRouteData>;

interface ServerLike {
  upgrade: (req: Request, opts?: { data?: unknown }) => boolean;
}

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

  const websocket: Bun.WebSocketHandler<WsRouteData | ProxyWebSocketData> = {
    open(ws) {
      if (isRouteData(ws.data)) {
        handlers.get(ws.data.route)?.open?.(ws as never);
      } else {
        proxy.open(ws as never);
      }
    },
    message(ws, message) {
      if (isRouteData(ws.data)) {
        handlers.get(ws.data.route)?.message?.(ws as never, message as never);
      } else {
        proxy.message(ws as never, message);
      }
    },
    close(ws, code, reason) {
      if (isRouteData(ws.data)) {
        handlers.get(ws.data.route)?.close?.(ws as never, code, reason);
      } else {
        proxy.close(ws as never);
      }
    },
  };

  function upgradeHandler(routePath: string): RouteHandler {
    return (req, server) => {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Upgrade Required", { status: 426 });
      }
      const params =
        (req as Request & { params?: Record<string, string> }).params ?? {};
      const data: WsRouteData = { route: routePath, params };
      const upgraded = (server as ServerLike | undefined)?.upgrade(req, {
        data,
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    };
  }

  return { upgradeHandler, websocket };
}
