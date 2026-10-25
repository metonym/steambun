import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDefaults } from "../src/config/loader";
import type { ProxyEntry } from "../src/config/types";
import { createApp } from "../src/runtime/app";
import { createProxyRouteHandler } from "../src/runtime/proxy";
import { freePort } from "./helpers";

const fakeServer = { upgrade: () => false };

interface Seen {
  path: string;
  headers: Headers;
}

const servers: Bun.Server<unknown>[] = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
});

/** A real upstream that records what reached it. */
function upstream(respond: () => Response = () => new Response("ok")) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: url.pathname + url.search, headers: req.headers });
      return respond();
    },
  });
  servers.push(server);
  return { seen, target: `http://localhost:${server.port}`, port: server.port };
}

async function proxy(
  entry: Parameters<typeof createProxyRouteHandler>[1],
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const handler = createProxyRouteHandler("/api", entry);
  return (await handler(
    new Request(`http://localhost:5173${path}`, init),
    fakeServer,
  )) as Response;
}

describe("createProxyRouteHandler", () => {
  test("forwards the path after the prefix and the query string", async () => {
    const up = upstream();
    const res = await proxy(up.target, "/api/users/42?sort=asc");
    expect(await res.text()).toBe("ok");
    expect(up.seen[0]?.path).toBe("/users/42?sort=asc");
  });

  test("rewrite is applied before the target path is joined", async () => {
    const up = upstream();
    await proxy(
      { target: up.target, rewrite: (path) => path.replace(/^\/legacy/, "") },
      "/api/legacy/users/42",
    );
    expect(up.seen[0]?.path).toBe("/users/42");
  });

  test("the target's own path stays in front of the request path", async () => {
    const up = upstream();
    await proxy(`${up.target}/v1/`, "/api/users");
    await proxy(`${up.target}/v1`, "/api/users?a=1");
    await proxy(
      {
        target: `${up.target}/v1`,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/api/api/foo",
    );
    expect(up.seen.map((s) => s.path)).toEqual([
      "/v1/users",
      "/v1/users?a=1",
      "/v1/foo",
    ]);
  });

  test("a request path starting with // cannot change the target host", async () => {
    const up = upstream();
    await proxy(up.target, "/api//evil.com/x");
    // It reaches this upstream, with "evil.com" as part of the path.
    expect(up.seen[0]?.path).toEndWith("/evil.com/x");
  });

  test("a path that URL normalization moved out of the prefix is not proxied", async () => {
    // Bun routes `/api/%2e%2e/admin` to `/api/*`, but `req.url` arrives as `/admin`.
    const up = upstream();
    for (const path of ["/admin", "/apix/y"]) {
      const res = await proxy(up.target, path);
      expect(res.status).toBe(404);
    }
    expect(up.seen).toEqual([]);
    expect((await proxy(up.target, "/api")).status).toBe(200);
    expect(up.seen[0]?.path).toBe("/");
  });

  test("headers named by Connection are hop-by-hop too", async () => {
    const up = upstream();
    await proxy(up.target, "/api/users", {
      headers: { connection: "X-Hop, keep-alive", "x-hop": "1", "x-keep": "1" },
    });
    expect(up.seen[0]?.headers.has("x-hop")).toBe(false);
    expect(up.seen[0]?.headers.get("x-keep")).toBe("1");
  });

  test("changeOrigin sets Host and Origin to the target", async () => {
    const up = upstream();
    const headers = {
      host: "localhost:5173",
      origin: "http://localhost:5173",
    };
    await proxy(up.target, "/api/users", { headers });
    await proxy({ target: up.target, changeOrigin: true }, "/api/users", {
      headers,
    });
    const [plain, changed] = up.seen;
    expect(plain?.headers.get("origin")).toBe("http://localhost:5173");
    expect(changed?.headers.get("origin")).toBe(up.target);
    expect(changed?.headers.get("host")).toBe(`localhost:${up.port}`);
  });

  test("changeOrigin sets X-Forwarded-* and never overwrites existing values", async () => {
    const up = upstream();
    const entry = { target: up.target, changeOrigin: true };
    await proxy(entry, "/api/users");
    await proxy(entry, "/api/users", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "example.com",
      },
    });
    const [added, kept] = up.seen;
    expect(added?.headers.get("x-forwarded-proto")).toBe("http");
    expect(added?.headers.get("x-forwarded-host")).toBe("localhost:5173");
    expect(kept?.headers.get("x-forwarded-proto")).toBe("https");
    expect(kept?.headers.get("x-forwarded-host")).toBe("example.com");
  });

  test("strips hop-by-hop headers in both directions", async () => {
    const up = upstream(
      () =>
        new Response("ok", {
          headers: { "proxy-authenticate": "Basic", "x-real": "1" },
        }),
    );
    const res = await proxy(up.target, "/api/users", {
      headers: { "proxy-authorization": "Basic x", "x-real": "1" },
    });
    expect(up.seen[0]?.headers.has("proxy-authorization")).toBe(false);
    expect(up.seen[0]?.headers.get("x-real")).toBe("1");
    expect(res.headers.has("proxy-authenticate")).toBe(false);
    expect(res.headers.get("x-real")).toBe("1");
  });

  test("forwards the method and body", async () => {
    let body = "";
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        body = `${req.method} ${await req.text()}`;
        return new Response(null, { status: 201 });
      },
    });
    servers.push(server);
    const res = await proxy(`http://localhost:${server.port}`, "/api/users", {
      method: "POST",
      body: "payload",
    });
    expect(res.status).toBe(201);
    expect(body).toBe("POST payload");
  });

  test("an unreachable target yields a 502 naming it", async () => {
    const target = `http://localhost:${await freePort()}`;
    const res = await proxy(target, "/api/users");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "proxy target unreachable",
      target,
    });
  });

  test("keeps an encoded upstream body encoded", async () => {
    const up = upstream(
      () =>
        new Response(Bun.gzipSync("hello"), {
          headers: { "content-encoding": "gzip" },
        }),
    );
    const res = await proxy(up.target, "/api/x", {
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(Bun.gunzipSync(await res.arrayBuffer())).toEqual(
      new TextEncoder().encode("hello"),
    );
  });
});

describe("server.proxy with ws: true", () => {
  async function serveApp(proxyEntry: Record<string, ProxyEntry>) {
    const root = mkdtempSync(join(tmpdir(), "steambun-proxy-ws-"));
    writeFileSync(join(root, "index.html"), "<html></html>");
    const config = resolveDefaults(
      { server: { proxy: proxyEntry } },
      { root, command: "dev", mode: "development", configFile: null },
    );
    const app = await createApp({ config, mode: "dev" });
    const server = Bun.serve({
      port: 0,
      ...app.serveOptions,
    } as Bun.Serve.Options<unknown>);
    servers.push(server);
    return server;
  }

  /** An echo WebSocket upstream that also reports the path it was dialed on. */
  function wsUpstream() {
    const paths: string[] = [];
    const closes: Array<[number, string]> = [];
    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        paths.push(new URL(req.url).pathname + new URL(req.url).search);
        return server.upgrade(req)
          ? undefined
          : new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, message) {
          if (message === "bye") ws.close();
          else if (message === "kick") ws.close(4001, "kicked");
          else ws.send(`echo: ${message}`);
        },
        close(_ws, code, reason) {
          closes.push([code, reason]);
        },
      },
    });
    servers.push(server);
    return { paths, closes, port: server.port };
  }

  function connect(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error(`could not connect to ${url}`));
    });
  }

  const nextMessage = (ws: WebSocket) =>
    new Promise<string>((resolve) => {
      ws.onmessage = (event) => resolve(String(event.data));
    });

  test("pipes messages both ways and dials the rewritten path", async () => {
    const up = wsUpstream();
    const server = await serveApp({
      "/socket": {
        target: `http://localhost:${up.port}`,
        ws: true,
        rewrite: (path: string) => path.replace(/^\/chat/, "/v2"),
      },
    });
    const ws = await connect(
      `ws://localhost:${server.port}/socket/chat?room=1`,
    );
    try {
      // Sent immediately: the upstream may still be connecting, so the client socket is paused.
      const reply = nextMessage(ws);
      ws.send("hi");
      expect(await reply).toBe("echo: hi");
      expect(up.paths).toEqual(["/v2?room=1"]);
    } finally {
      ws.close();
    }
  });

  test("closing the upstream closes the client", async () => {
    const up = wsUpstream();
    const server = await serveApp({
      "/socket": { target: `http://localhost:${up.port}`, ws: true },
    });
    const ws = await connect(`ws://localhost:${server.port}/socket`);
    const closed = new Promise<void>((resolve) => {
      ws.onclose = () => resolve();
    });
    ws.send("bye");
    await closed;
  });

  test("close codes and reasons pass through both ways", async () => {
    const up = wsUpstream();
    const server = await serveApp({
      "/socket": { target: `http://localhost:${up.port}`, ws: true },
    });
    const kicked = await connect(`ws://localhost:${server.port}/socket`);
    const event = await new Promise<CloseEvent>((resolve) => {
      kicked.onclose = resolve;
      kicked.send("kick");
    });
    expect([event.code, event.reason]).toEqual([4001, "kicked"]);

    const leaving = await connect(`ws://localhost:${server.port}/socket`);
    await new Promise<void>((resolve) => {
      leaving.onclose = () => resolve();
      leaving.close(4002, "bye");
    });
    await Bun.sleep(50);
    expect(up.closes).toContainEqual([4002, "bye"]);
  });

  test("an unreachable upstream closes the client with 1014 Bad Gateway", async () => {
    const dead = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = dead.port;
    dead.stop(true);
    const server = await serveApp({
      "/socket": { target: `http://localhost:${port}`, ws: true },
    });
    const ws = await connect(`ws://localhost:${server.port}/socket`);
    const event = await new Promise<CloseEvent>((resolve) => {
      ws.onclose = resolve;
    });
    expect([event.code, event.reason]).toEqual([1014, "Bad Gateway"]);
  });

  test("without ws: true an upgrade request is not proxied as a socket", async () => {
    const up = wsUpstream();
    const server = await serveApp({
      "/socket": { target: `http://localhost:${up.port}` },
    });
    await expect(
      connect(`ws://localhost:${server.port}/socket`),
    ).rejects.toThrow("could not connect");
  });
});
