// Multi-page app: any second *.html file at the project root is discovered
// and routed automatically (here, /about) — no rollupOptions.input needed.
document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <nav class="mb-4"><a class="mr-4 text-blue-600 underline" href="/">index</a><a class="text-blue-600 underline" href="/about">about</a></nav>
  <h1 class="text-2xl font-bold">about</h1>
  <p class="text-slate-600">A second HTML entrypoint, auto-routed to /about.</p>
  <p id="chat-log" class="mt-4 text-sm text-slate-500"></p>
`;

// File-based WebSocket route: src/api/chat/[room].ts -> /api/chat/:room.
const log = document.querySelector<HTMLParagraphElement>("#chat-log")!;
const chat = new WebSocket(`ws://${location.host}/api/chat/lobby`);
chat.onopen = () => chat.send("hello from about.ts");
chat.onmessage = (event) => {
  log.textContent = `chat: ${event.data}`;
};
