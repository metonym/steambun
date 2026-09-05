import { api } from "steambun/client";
import { gitSha } from "./git-sha.ts" with { type: "macro" };
import greeting from "./greeting.upper";
import { nav } from "./nav";

const sha = gitSha();
console.log(`steambun fullstack ${sha}`);

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  ${nav("index")}
  <h1 class="text-2xl font-bold">steambun fullstack</h1>
  <p class="mb-4 text-slate-600">${import.meta.env.PUBLIC_GREETING} · ${import.meta.env.PUBLIC_TITLE} (mode: ${import.meta.env.MODE}, dev: ${import.meta.env.DEV}, ${sha})</p>
  <p class="mb-4 rounded bg-slate-900 px-3 py-1 text-white">${greeting}</p>

  <section class="mb-4 rounded-lg border border-slate-300 p-4">
    <h2 class="mb-2 text-sm font-semibold text-slate-500">native api route — GET /api/health</h2>
    <pre id="health" class="overflow-x-auto rounded bg-slate-100 p-2">loading…</pre>
  </section>

  <section class="mb-4 rounded-lg border border-slate-300 p-4">
    <h2 class="mb-2 text-sm font-semibold text-slate-500">native api route (default export, all methods) — POST /api/echo</h2>
    <pre id="echo" class="overflow-x-auto rounded bg-slate-100 p-2">loading…</pre>
  </section>

  <section class="mb-4 rounded-lg border border-slate-300 p-4">
    <h2 class="mb-2 text-sm font-semibold text-slate-500">typed client (steambun/client) — GET /api/users/:id</h2>
    <pre id="user" class="overflow-x-auto rounded bg-slate-100 p-2">loading…</pre>
  </section>

  <section class="mb-4 rounded-lg border border-slate-300 p-4">
    <h2 class="mb-2 text-sm font-semibold text-slate-500">proxied legacy backend — GET /legacy/status</h2>
    <pre id="legacy" class="overflow-x-auto rounded bg-slate-100 p-2">loading… (run \`bun run legacy-api\` in another terminal)</pre>
  </section>

  <section class="mb-4 rounded-lg border border-slate-300 p-4">
    <h2 class="mb-2 text-sm font-semibold text-slate-500">proxied legacy WebSocket — /legacy/echo</h2>
    <pre id="ws" class="overflow-x-auto rounded bg-slate-100 p-2">connecting…</pre>
  </section>
`;

const set = (id: string, value: unknown) => {
  app.querySelector(`#${id}`)!.textContent =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
};

fetch("/api/health")
  .then((res) => res.json())
  .then((data) => set("health", data))
  .catch((err) => set("health", String(err)));

fetch("/api/echo", { method: "POST", body: JSON.stringify({ hi: 1 }) })
  .then((res) => res.json())
  .then((data) => set("echo", data))
  .catch((err) => set("echo", String(err)));

// `path` and `params` are checked against the generated .steambun/routes.d.ts
// (try a typo in "id" below). The GET handler here returns a bare Response,
// so `user` types as `unknown` — wrap a handler in route() (see
// tests/fixtures/typed/users-id.ts) for the value type to flow through too.
api("get", "/api/users/:id", { params: { id: "42" } })
  .then((user) => set("user", user))
  .catch((err) => set("user", String(err)));

fetch("/legacy/status")
  .then((res) => res.json())
  .then((data) => set("legacy", data))
  .catch(() =>
    set("legacy", "failed — run `bun run legacy-api` in another terminal."),
  );

const ws = new WebSocket(`ws://${location.host}/legacy/echo`);
ws.onopen = () => ws.send("hello over the proxied websocket");
ws.onmessage = (event) => set("ws", event.data);
ws.onerror = () =>
  set("ws", "failed — run `bun run legacy-api` in another terminal.");
