import { describe, expect, test } from "bun:test";
import { createProxyRouteHandler } from "../src/runtime/proxy";

const fakeServer = { upgrade: () => false };

describe("createProxyRouteHandler", () => {
  test("string target forwards pathname after prefix and query string", async () => {
    let fetched: { href: string; duplex?: string } | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const href =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      fetched = {
        href,
        duplex: (init as { duplex?: string } | undefined)?.duplex,
      };
      return new Response("ok");
    }) as typeof fetch;

    try {
      const handler = createProxyRouteHandler("/api", "http://localhost:4100");
      await handler(
        new Request("http://localhost:5173/api/users/42?sort=asc"),
        fakeServer,
      );
      expect(fetched?.href).toBe("http://localhost:4100/users/42?sort=asc");
      expect(fetched?.duplex).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("changeOrigin sets Host and Origin to the target", async () => {
    const captured: { host: string | null; origin: string | null } = {
      host: null,
      origin: null,
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const headers = new Headers(init?.headers);
      captured.host = headers.get("host");
      captured.origin = headers.get("origin");
      return new Response("ok");
    }) as typeof fetch;

    try {
      const handler = createProxyRouteHandler("/api", {
        target: "http://localhost:4100",
        changeOrigin: true,
      });
      await handler(
        new Request("http://localhost:5173/api/users", {
          headers: { host: "localhost:5173", origin: "http://localhost:5173" },
        }),
        fakeServer,
      );
      expect(captured.host).toBe("localhost:4100");
      expect(captured.origin).toBe("http://localhost:4100");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rewrite is applied before resolve", async () => {
    let href: string | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      href =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      return new Response("ok");
    }) as typeof fetch;

    try {
      const handler = createProxyRouteHandler("/api", {
        target: "http://localhost:4100",
        rewrite: (path) => path.replace(/^\/legacy/, ""),
      });
      await handler(
        new Request("http://localhost:5173/api/legacy/users/42"),
        fakeServer,
      );
      expect(href).toBe("http://localhost:4100/users/42");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejecting fetch yields a 502 with the target", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;

    try {
      const handler = createProxyRouteHandler("/api", "http://localhost:4100");
      const res = (await handler(
        new Request("http://localhost:5173/api/users"),
        fakeServer,
      )) as Response;
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        error: "proxy target unreachable",
        target: "http://localhost:4100",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("changeOrigin sets X-Forwarded-* and never overwrites existing values", async () => {
    let captured = new Headers();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      captured = new Headers(init?.headers);
      return new Response("ok");
    }) as typeof fetch;

    try {
      const handler = createProxyRouteHandler("/api", {
        target: "http://localhost:4100",
        changeOrigin: true,
      });

      await handler(new Request("http://localhost:5173/api/users"), fakeServer);
      expect(captured.get("x-forwarded-proto")).toBe("http");
      expect(captured.get("x-forwarded-host")).toBe("localhost:5173");

      await handler(
        new Request("http://localhost:5173/api/users", {
          headers: {
            "x-forwarded-proto": "https",
            "x-forwarded-host": "example.com",
          },
        }),
        fakeServer,
      );
      expect(captured.get("x-forwarded-proto")).toBe("https");
      expect(captured.get("x-forwarded-host")).toBe("example.com");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("strips hop-by-hop headers in both directions", async () => {
    let captured = new Headers();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      captured = new Headers(init?.headers);
      return new Response("ok", {
        headers: { connection: "keep-alive", "x-real": "1" },
      });
    }) as typeof fetch;

    try {
      const handler = createProxyRouteHandler("/api", "http://localhost:4100");
      const res = (await handler(
        new Request("http://localhost:5173/api/users", {
          headers: { connection: "keep-alive", "x-real": "1" },
        }),
        fakeServer,
      )) as Response;

      expect(captured.has("connection")).toBe(false);
      expect(captured.get("x-real")).toBe("1");
      expect(res.headers.has("connection")).toBe(false);
      expect(res.headers.get("x-real")).toBe("1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("target with a path prefix still WHATWG-joins", async () => {
    let href: string | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      href =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      return new Response("ok");
    }) as typeof fetch;

    try {
      const handler = createProxyRouteHandler(
        "/api",
        "http://localhost:4100/v1/",
      );
      await handler(new Request("http://localhost:5173/api/users"), fakeServer);
      expect(href).toBe("http://localhost:4100/users");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
