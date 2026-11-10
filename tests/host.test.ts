import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../src/core/host.ts";
import { jsonSettings } from "../src/core/settings.ts";

const dir = mkdtempSync(join(tmpdir(), "steambun-"));
const server = serve({
  port: 0,
  quiet: true,
  settings: jsonSettings(join(dir, "s.json")),
  routes: { "/hi/:name": (req) => Response.json(req.params.name) },
  fetch: (req) =>
    new URL(req.url).pathname === "/x" ? new Response("x") : undefined,
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
  expect(await (await fetch(`${base}/_steambun/settings`)).json()).toEqual({
    a: "1",
  });
  expect(jsonSettings(join(dir, "s.json")).all()).toEqual({ a: "1" });
  const bad = await fetch(`${base}/_steambun/settings`, {
    method: "PUT",
    body: "[]",
  });
  expect(bad.status).toBe(400);
});

test("the shell link needs the token", async () => {
  const r = await fetch(`${base}/_steambun/ws`, {
    headers: { upgrade: "websocket" },
  });
  expect(r.status).toBe(403);
});

test("browser API: pages of ours only", async () => {
  const r = await fetch(`${base}/_steambun/browser/info`, {
    method: "POST",
    body: "{}",
  });
  expect(r.status).toBe(403);
});

test("the app's sockets reach the app's handler", async () => {
  const s2 = serve({
    port: 0,
    quiet: true,
    settings: false,
    browser: false,
    fetch: (req, srv) =>
      srv.upgrade(req, { data: { app: true } })
        ? undefined
        : new Response("no", { status: 400 }),
    websocket: {
      data: {} as { app: true },
      message: (ws, m) => void ws.send(`echo ${m}`),
    },
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

const host = base.replace("http://", "");
const at = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);

test("a foreign Host is refused (DNS rebinding)", async () => {
  const r = await at("/hi/bun", { headers: { host: "evil.example" } });
  expect(r.status).toBe(403);
  const f = await at("/x", {
    headers: { host: `evil.example:${server.port}` },
  });
  expect(f.status).toBe(403);
});

test("a cross-site write is refused", async () => {
  const put = (headers: Record<string, string>) =>
    at("/_steambun/settings", { method: "PUT", headers, body: "{}" });
  expect((await put({ origin: "https://evil.example" })).status).toBe(403);
  expect((await put({ origin: "null" })).status).toBe(403);
  expect((await put({ "sec-fetch-site": "cross-site" })).status).toBe(403);
  // Another port on localhost is the same site but not the same origin.
  expect((await put({ "sec-fetch-site": "same-site" })).status).toBe(403);
});

test("our pages, local processes and cross-site links still work", async () => {
  const ours = { origin: `http://${host}`, "sec-fetch-site": "same-origin" };
  const put = (headers: Record<string, string>) =>
    at("/_steambun/settings", { method: "PUT", headers, body: "{}" });
  expect((await put(ours)).status).toBe(200);
  expect(
    (await at("/hi/bun", { headers: { "sec-fetch-site": "none" } })).status,
  ).toBe(200);
  expect((await at("/hi/bun")).status).toBe(200);
  const link = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" };
  expect((await at("/x", { headers: link })).status).toBe(200);
  // A navigation can't carry a write.
  expect((await put(link)).status).toBe(403);
});

test("a foreign page can't open the app's socket", async () => {
  const r = await at("/x", {
    headers: { upgrade: "websocket", origin: "https://evil.example" },
  });
  expect(r.status).toBe(403);
});
