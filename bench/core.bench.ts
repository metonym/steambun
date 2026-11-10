// The core at run time: what serve() adds on top of a bare Bun.serve, and
// what the page's settings and an app's WebSocket cost through it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { group, task } from "ostia";
import { serve } from "../src/core/host.ts";
import { jsonSettings } from "../src/core/settings.ts";

const dir = mkdtempSync(join(tmpdir(), "steambun-bench-"));
const hi = () => Response.json("hi");

const bare = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  routes: { "/hi": hi },
  fetch: () => new Response("not found", { status: 404 }),
});
const ours = serve({
  port: 0,
  quiet: true,
  settings: jsonSettings(join(dir, "settings.json")),
  routes: { "/hi": hi },
  fetch: (req, srv) =>
    new URL(req.url).pathname === "/ws" && srv.upgrade(req, { data: {} })
      ? undefined
      : new Response("not found", { status: 404 }),
  websocket: {
    data: {} as object,
    message: (ws, m) => void ws.send(m),
  },
});
const url = (s: { url: URL }, path: string) => new URL(path, s.url).href;

const store = jsonSettings(join(dir, "store.json"));
// A page with a few dozen settings: theme, layout, panes, recent items.
for (let i = 0; i < 40; i++) store.put({ [`ui.key${i}`]: `value ${i}` });

const ws = new WebSocket(url(ours, "/ws").replace("http", "ws"));
await new Promise((ok, fail) => {
  ws.onopen = ok;
  ws.onerror = () => fail(new Error("the bench socket didn't open"));
});
const echo = () =>
  new Promise((r) => {
    ws.onmessage = r;
    ws.send("ping");
  });

group("serve", () => {
  task(
    "route, bare Bun.serve",
    () => fetch(url(bare, "/hi")).then((r) => r.json()),
    {
      baseline: true,
    },
  );
  task("route, steambun serve()", () =>
    fetch(url(ours, "/hi")).then((r) => r.json()),
  );
  task("404 through fetch", () =>
    fetch(url(ours, "/nope")).then((r) => r.text()),
  );
  task("WebSocket echo", echo);
});

group("settings", () => {
  task("GET /_steambun/settings", () =>
    fetch(url(ours, "/_steambun/settings")).then((r) => r.json()),
  );
  task("PUT one key", () =>
    fetch(url(ours, "/_steambun/settings"), {
      method: "PUT",
      body: JSON.stringify({ "ui.theme": "dark" }),
    }).then((r) => r.json()),
  );
  task("store.put, 40 keys on disk", () => store.put({ "ui.width": "320" }));
  task("store.all, 40 keys", () => store.all());
});
