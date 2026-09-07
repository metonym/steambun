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

// client.ts reads `import.meta.env.BASE_URL` as a plain member expression so
// Bun's build-time `define` can replace it (see the comment in client.ts) —
// meaning it only resolves once bundled, same as Vite. Bundle it fresh per
// test so BASE_URL is always defined, never `undefined` at runtime.
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
    expect(href("/api/users/:id", { id: "7" })).toBe("/api/users/7");
    expect(href("/about")).toBe("/about");
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
