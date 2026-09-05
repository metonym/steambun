import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDefaults } from "../src/config/loader";
import { createApp } from "../src/runtime/app";

function tmpApiDir(): string {
  const root = mkdtempSync(join(tmpdir(), "steambun-ws-"));
  const apiDir = join(root, "api");
  mkdirSync(join(apiDir, "chat"), { recursive: true });
  writeFileSync(
    join(apiDir, "chat", "[room].ts"),
    `export const websocket = {
  open(ws) { ws.subscribe(ws.data.params.room); },
  message(ws, msg) { ws.publish(ws.data.params.room, msg); ws.send(\`echo: \${msg}\`); },
};
export const GET = (req) => Response.json({ room: req.params.room });
`,
  );
  writeFileSync(
    join(apiDir, "sse.ts"),
    `export const GET = () => new Response("data: hi\\n\\n", { headers: { "content-type": "text/event-stream" } });
`,
  );
  return apiDir;
}

function baseConfig(apiDir: string, overrides: Record<string, unknown> = {}) {
  return resolveDefaults(
    { api: "api", publicDir: false, ...overrides },
    {
      root: join(apiDir, ".."),
      command: "dev",
      mode: "development",
      configFile: null,
    },
  );
}

describe("file-based WebSocket routes", () => {
  test("connects, echoes a message, and GET without Upgrade returns JSON", async () => {
    const apiDir = tmpApiDir();
    const config = baseConfig(apiDir);
    const app = await createApp({ config, mode: "dev" });
    const server = Bun.serve({
      port: 0,
      ...app.serveOptions,
    } as Bun.Serve.Options<unknown>);

    try {
      const getRes = await fetch(
        `http://localhost:${server.port}/api/chat/lobby`,
      );
      expect(await getRes.json()).toEqual({ room: "lobby" });

      const message = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://localhost:${server.port}/api/chat/lobby`,
        );
        ws.onopen = () => ws.send("hi");
        ws.onmessage = (event) => {
          resolve(event.data as string);
          ws.close();
        };
        ws.onerror = reject;
      });
      expect(message).toBe("echo: hi");
    } finally {
      server.stop(true);
    }
  });

  test("middleware returning a Response blocks the upgrade", async () => {
    const apiDir = tmpApiDir();
    const config = baseConfig(apiDir, {
      middleware: [async () => new Response("nope", { status: 401 })],
    });
    const app = await createApp({ config, mode: "dev" });
    const server = Bun.serve({
      port: 0,
      ...app.serveOptions,
    } as Bun.Serve.Options<unknown>);

    try {
      const res = await fetch(
        `http://localhost:${server.port}/api/chat/lobby`,
        {
          headers: { upgrade: "websocket" },
        },
      );
      expect(res.status).toBe(401);
    } finally {
      server.stop(true);
    }
  });

  test("a GET-only path with no websocket export is unaffected", async () => {
    const apiDir = tmpApiDir();
    const config = baseConfig(apiDir);
    const app = await createApp({ config, mode: "dev" });
    const res = await app.fetch(new Request("http://localhost/api/sse"));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });
});

describe("SSE responses disable Bun's idle timeout", () => {
  test("server.timeout(req, 0) is called for a text/event-stream response", async () => {
    const apiDir = tmpApiDir();
    const config = baseConfig(apiDir);
    const app = await createApp({ config, mode: "dev" });

    const calls: Array<[Request, number]> = [];
    const stubServer = {
      timeout: (req: Request, seconds: number) => {
        calls.push([req, seconds]);
      },
    };

    const methodHandlers = app.routes["/api/sse"] as Record<
      string,
      (req: Request, server: unknown) => Promise<Response> | Response
    >;
    const req = new Request("http://localhost/api/sse");
    const res = await methodHandlers.GET!(req, stubServer);

    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toBe(0);
  });
});
