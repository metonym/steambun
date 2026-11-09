// Multi-page app: any second *.html file at the project root is discovered
// and routed automatically (here, /about) — no rollupOptions.input needed.
import { ws } from "steambun/client";
import { nav } from "./nav";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  ${nav("about")}
  <h1 class="text-2xl font-bold">about</h1>
  <p class="text-slate-600">A second HTML entrypoint, auto-routed to /about.</p>
  <p id="chat-log" class="mt-4 text-sm text-slate-500"></p>
`;

// File-based WebSocket route: src/api/chat/[room].ts -> /api/chat/:room,
// typed against the generated .steambun/routes.d.ts.
const log = document.querySelector<HTMLParagraphElement>("#chat-log")!;
const chat = ws("/api/chat/:room", { params: { room: "lobby" } });
chat.on("open", () => chat.send("hello from about.ts"));
chat.on("message", (event) => {
  log.textContent = `chat: ${(event as MessageEvent).data}`;
});
