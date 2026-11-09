// File-based WebSocket route: exporting `websocket` alongside an HTTP
// method turns this into a chat room at /api/chat/:room. GET is optional —
// it's here so a plain fetch can check a room exists before connecting.
export const websocket = {
  open(ws: Bun.ServerWebSocket<{ params: { room: string } }>) {
    ws.subscribe(ws.data.params.room);
  },
  message(
    ws: Bun.ServerWebSocket<{ params: { room: string } }>,
    message: string | Buffer,
  ) {
    // publish() excludes the sender, so echo back too — every client in the
    // room (including this one) ends up seeing every message.
    ws.publish(ws.data.params.room, message);
    ws.send(message);
  },
};

export const GET = (req: Request & { params: { room: string } }) =>
  Response.json({ room: req.params.room });
