// Simulates a pre-existing backend that isn't part of this steambun project —
// exactly the case `server.proxy` exists for. Run alongside `bun run dev` (in
// a separate terminal) with `bun run legacy-api`. Exposes both a plain HTTP
// route and a WebSocket echo route, proxied at /legacy/* with `ws: true`.
const server = Bun.serve({
  port: 4200,
  routes: {
    "/status": () => Response.json({ ok: true, from: "legacy backend" }),
    "/echo": (req, server) => {
      if (server.upgrade(req)) return;
      return new Response("Upgrade failed", { status: 500 });
    },
  },
  websocket: {
    message(ws, message) {
      ws.send(`echo: ${message}`);
    },
  },
});

console.log(`[legacy-api] listening at ${server.url}`);

export {};
