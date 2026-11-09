import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonSettings } from "./settings.ts";
import { serve } from "./host.ts";

const dir = mkdtempSync(join(tmpdir(), "steambun-"));
const server = serve({
  port: 0,
  quiet: true,
  settings: jsonSettings(join(dir, "s.json")),
  routes: { "/hi/:name": (req) => Response.json(req.params.name) },
  fetch: (req) => (new URL(req.url).pathname === "/x" ? new Response("x") : undefined),
  websocket: {
    data: {} as { app: true },
    message: (ws, m) => void ws.send(`echo ${m}`),
  },
});
const base = String(server.url).replace(/\/$/, "");
afterAll(() => server.stop(true));

test("app routes, fetch and 404 still work", async () => {
  expect(await (await fetch(`${base}/hi/bun`)).json()).toBe("bun");
  expect(await (await fetch(`${base}/x`)).text()).toBe("x");
  expect((await fetch(`${base}/nope`)).status).toBe(404);
});

test("settings round-trip, persist, and drop bad values", async () => {
  const put = await fetch(`${base}/_steambun/settings`, {
    method: "PUT",
    body: JSON.stringify({ a: "1", b: 2, c: null }),
  });
  expect(put.status).toBe(200);
  expect(await (await fetch(`${base}/_steambun/settings`)).json()).toEqual({ a: "1" });
  expect(jsonSettings(join(dir, "s.json")).all()).toEqual({ a: "1" });
  const bad = await fetch(`${base}/_steambun/settings`, { method: "PUT", body: "[]" });
  expect(bad.status).toBe(400);
});

test("the shell link needs the token", async () => {
  const r = await fetch(`${base}/_steambun/ws`, { headers: { upgrade: "websocket" } });
  expect(r.status).toBe(403);
});

test("browser API: pages of ours only", async () => {
  const r = await fetch(`${base}/_steambun/browser/info`, { method: "POST", body: "{}" });
  expect(r.status).toBe(403);
});

test("the app's sockets reach the app's handler", async () => {
  const s2 = serve({
    port: 0,
    quiet: true,
    settings: false,
    browser: false,
    fetch: (req, srv) => (srv.upgrade(req, { data: { app: true } }) ? undefined : new Response("no", { status: 400 })),
    websocket: { data: {} as { app: true }, message: (ws, m) => void ws.send(`echo ${m}`) },
  });
  const ws = new WebSocket(String(s2.url).replace("http", "ws"));
  const got = await new Promise<string>((res, rej) => {
    ws.onopen = () => ws.send("hi");
    ws.onmessage = (e) => res(String(e.data));
    ws.onerror = rej;
  });
  ws.close();
  s2.stop(true);
  expect(got).toBe("echo hi");
});
