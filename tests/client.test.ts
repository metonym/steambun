import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SteambunApiError as SteambunApiErrorType } from "../src/client";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

type ClientModule = typeof import("../src/client");

// `import.meta.env.BASE_URL` only resolves once bundled, so bundle per test.
async function loadClient(base = "/"): Promise<ClientModule> {
  const outdir = mkdtempSync(join(tmpdir(), "steambun-client-build-"));
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "../src/client.ts")],
    outdir,
    target: "browser",
    define: { "import.meta.env.BASE_URL": JSON.stringify(base) },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("client.ts bundle failed");
  }
  return import(result.outputs[0]!.path) as Promise<ClientModule>;
}

function stubFetch(
  handler: (url: string, init?: RequestInit) => Response,
): Array<[string, RequestInit | undefined]> {
  const calls: Array<[string, RequestInit | undefined]> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push([url, init]);
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

describe("api()", () => {
  test("substitutes :param segments and appends query", async () => {
    const { api } = await loadClient();
    const calls = stubFetch(
      () =>
        new Response(JSON.stringify({ id: "42" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await api("get", "/api/users/:id", {
      params: { id: "42" },
      query: { verbose: "1" },
    });
    expect(result).toEqual({ id: "42" });
    expect(calls[0]?.[0]).toBe("/api/users/42?verbose=1");
  });

  test("JSON-encodes body and sets content-type", async () => {
    const { api } = await loadClient();
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    await api("post", "/api/users", { body: { name: "ada" } });
    const [, init] = calls[0]!;
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(init?.body).toBe(JSON.stringify({ name: "ada" }));
  });

  test("doesn't override a caller-set content-type", async () => {
    const { api } = await loadClient();
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    await api("post", "/api/x", {
      body: { a: 1 },
      init: { headers: { "content-type": "application/vnd.api+json" } },
    });
    const [, init] = calls[0]!;
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/vnd.api+json",
    );
    expect(init?.body).toBe(JSON.stringify({ a: 1 }));
  });

  test("resolves undefined for a 204 response", async () => {
    const { api } = await loadClient();
    stubFetch(() => new Response(null, { status: 204 }));
    const result = await api("delete", "/api/users/:id", {
      params: { id: "1" },
    });
    expect(result).toBeUndefined();
  });

  test("resolves raw text for a non-JSON success response", async () => {
    const { api } = await loadClient();
    stubFetch(
      () =>
        new Response("plain text", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );
    const result = await api("get", "/api/text");
    expect(result).toBe("plain text");
  });

  test("throws SteambunApiError with status and body on a non-2xx response", async () => {
    const { api } = await loadClient();
    stubFetch(
      () => new Response(JSON.stringify({ error: "nope" }), { status: 500 }),
    );
    let error: SteambunApiErrorType | undefined;
    try {
      await api("get", "/api/broken");
    } catch (err) {
      error = err as SteambunApiErrorType;
    }
    expect(error).toBeDefined();
    expect(error?.status).toBe(500);
    expect(error?.body).toEqual({ error: "nope" });
    expect(error?.message).toContain("GET /api/broken");
  });
});

describe("href()", () => {
  test("substitutes :param segments", async () => {
    const { href } = await loadClient();
    expect(href("/api/users/:id", { params: { id: "7" } })).toBe(
      "/api/users/7",
    );
    expect(href("/about")).toBe("/about");
  });

  test("appends a query string", async () => {
    const { href } = await loadClient();
    expect(href("/about", { query: { tab: "info" } })).toBe("/about?tab=info");
    expect(
      href("/api/users/:id", {
        params: { id: "7" },
        query: { debug: "1" },
      }),
    ).toBe("/api/users/7?debug=1");
  });
});

describe("missing params and array queries", () => {
  test("api(), href(), and ws() throw on an unsubstituted :param", async () => {
    const { api, href, ws } = await loadClient();
    stubFetch(() => new Response("{}", { status: 200 }));
    await expect(api("get", "/api/users/:id")).rejects.toThrow(
      'missing value for ":id"',
    );
    expect(() => href("/api/users/:id")).toThrow('missing value for ":id"');
    const { restore } = stubWebSocket();
    try {
      expect(() => ws("/api/chat/:room")).toThrow('missing value for ":room"');
    } finally {
      restore();
    }
  });

  test("a host port in an absolute ws() url is not a param", async () => {
    const { ws } = await loadClient();
    const { instances, restore } = stubWebSocket();
    try {
      ws("http://example.test:8080/api/chat");
      expect(instances[0]?.url).toBe("ws://example.test:8080/api/chat");
    } finally {
      restore();
    }
  });

  test("array query values repeat the key in href() and ws()", async () => {
    const { href, ws } = await loadClient();
    expect(href("/about", { query: { tag: ["a", "b"], q: "1" } })).toBe(
      "/about?tag=a&tag=b&q=1",
    );
    const { instances, restore } = stubWebSocket();
    try {
      ws("/api/chat/:room", {
        params: { room: "1" },
        query: { tag: ["a", "b"] },
      });
      expect(instances[0]?.url).toBe(
        "ws://example.test/api/chat/1?tag=a&tag=b",
      );
    } finally {
      restore();
    }
  });
});

describe("import.meta.env.BASE_URL prefixing", () => {
  test("prefixes both api() and href() when BASE_URL is defined", async () => {
    const { api, href } = await loadClient("/app/");

    expect(href("/about")).toBe("/app/about");

    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    await api("get", "/api/health");
    expect(calls[0]?.[0]).toBe("/app/api/health");
  });
});

interface FakeWebSocketInstance {
  url: string;
  protocols?: string | string[];
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: Event) => void) | null;
  onclose: ((ev: Event) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send(data: unknown): void;
  close(code?: number, reason?: string): void;
  fireOpen(): void;
  fireClose(): void;
  fireMessage(): void;
}

function stubWebSocket(): {
  instances: FakeWebSocketInstance[];
  restore: () => void;
} {
  const instances: FakeWebSocketInstance[] = [];
  class FakeWebSocket implements FakeWebSocketInstance {
    url: string;
    protocols?: string | string[];
    onopen: ((ev: Event) => void) | null = null;
    onmessage: ((ev: Event) => void) | null = null;
    onclose: ((ev: Event) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    constructor(url: string, protocols?: string | string[]) {
      this.url = url;
      this.protocols = protocols;
      instances.push(this);
    }
    send(_data: unknown) {}
    close(_code?: number, _reason?: string) {}
    fireOpen() {
      this.onopen?.(new Event("open"));
    }
    fireClose() {
      this.onclose?.(new Event("close"));
    }
    fireMessage() {
      this.onmessage?.(new Event("message"));
    }
  }
  const originalWebSocket = globalThis.WebSocket;
  // @ts-expect-error test stub, not a real WebSocket constructor
  globalThis.WebSocket = FakeWebSocket;

  const originalLocation = globalThis.location;
  // @ts-expect-error stubbing a browser global not present under bun test
  globalThis.location = { href: "http://example.test/" };
  const restore = () => {
    globalThis.WebSocket = originalWebSocket;
    globalThis.location = originalLocation;
  };

  return { instances, restore };
}

describe("ws()", () => {
  test("substitutes params and query, and uses ws:// for an http: base", async () => {
    const { ws } = await loadClient();
    const { instances, restore } = stubWebSocket();
    try {
      ws("/api/chat/:room", { params: { room: "42" }, query: { a: "1" } });
      expect(instances[0]?.url).toBe("ws://example.test/api/chat/42?a=1");
    } finally {
      restore();
    }
  });

  test("flips https: to wss: for an absolute path", async () => {
    const { ws } = await loadClient();
    const { instances, restore } = stubWebSocket();
    try {
      ws("https://example.test/api/chat/general");
      expect(instances[0]?.url).toBe("wss://example.test/api/chat/general");
    } finally {
      restore();
    }
  });

  test("reconnects after close when reconnect is set, but not after wrapper close()", async () => {
    const { ws } = await loadClient();
    const { instances, restore } = stubWebSocket();
    try {
      const socket = ws("/api/chat/:room", {
        params: { room: "42" },
        reconnect: { maxAttempts: 1, baseDelayMs: 1 },
      });
      expect(instances).toHaveLength(1);
      instances[0]?.fireClose();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(instances).toHaveLength(2);

      socket.close();
      instances[1]?.fireClose();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(instances).toHaveLength(2);
    } finally {
      restore();
    }
  });

  test("close() while a reconnect is pending cancels it", async () => {
    const { ws } = await loadClient();
    const { instances, restore } = stubWebSocket();
    try {
      const socket = ws("/api/chat/:room", {
        params: { room: "42" },
        reconnect: { baseDelayMs: 5 },
      });
      instances[0]?.fireClose();
      socket.close();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(instances).toHaveLength(1);
    } finally {
      restore();
    }
  });

  test("maxAttempts: 0 disables reconnecting (0 is not treated as unset)", async () => {
    const { ws } = await loadClient();
    const { instances, restore } = stubWebSocket();
    try {
      ws("/api/chat/:room", {
        params: { room: "42" },
        reconnect: { maxAttempts: 0, baseDelayMs: 1 },
      });
      expect(instances).toHaveLength(1);
      instances[0]?.fireClose();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(instances).toHaveLength(1);
    } finally {
      restore();
    }
  });

  test("on() returns an unsubscribe function", async () => {
    const { ws } = await loadClient();
    const { instances, restore } = stubWebSocket();
    try {
      const socket = ws("/api/chat/:room", { params: { room: "1" } });
      let count = 0;
      const off = socket.on("message", () => count++);
      instances[0]?.fireMessage();
      off();
      instances[0]?.fireMessage();
      expect(count).toBe(1);
    } finally {
      restore();
    }
  });

  test("send() throws while a reconnect is pending, then works again once reconnected", async () => {
    const { ws } = await loadClient();
    const { instances, restore } = stubWebSocket();
    try {
      const socket = ws("/api/chat/:room", {
        params: { room: "1" },
        reconnect: { baseDelayMs: 5 },
      });
      instances[0]?.fireClose();
      expect(() => socket.send("hi")).toThrow("reconnect is pending");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(instances).toHaveLength(2);
      expect(() => socket.send("hi")).not.toThrow();
      socket.close();
    } finally {
      restore();
    }
  });
});
