import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeServerMiddleware,
  corsMiddleware,
  createErrorHandler,
  headersMiddleware,
  serveWithPortRetry,
} from "../src/runtime/http";
import type { Middleware } from "../src/runtime/middleware";
import { withMiddleware } from "../src/runtime/middleware";
import { listPublicFiles } from "../src/runtime/public-dir";

describe("corsMiddleware", () => {
  test("OPTIONS returns 204 with CORS headers", async () => {
    const wrapped = withMiddleware(
      [corsMiddleware()],
      () => new Response("ok"),
    );
    const res = await wrapped(
      new Request("http://localhost/api", { method: "OPTIONS" }),
    );
    expect(res?.status).toBe(204);
    expect(res?.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  test("GET responses get CORS headers", async () => {
    const wrapped = withMiddleware(
      [corsMiddleware()],
      () => new Response("ok"),
    );
    const res = await wrapped(new Request("http://localhost/api"));
    expect(await res?.text()).toBe("ok");
    expect(res?.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  test("preflight reflects Access-Control-Request-Headers", async () => {
    const wrapped = withMiddleware(
      [corsMiddleware()],
      () => new Response("ok"),
    );
    const res = await wrapped(
      new Request("http://localhost/api", {
        method: "OPTIONS",
        headers: { "Access-Control-Request-Headers": "x-custom, content-type" },
      }),
    );
    expect(res?.headers.get("Access-Control-Allow-Headers")).toBe(
      "x-custom, content-type",
    );
    expect(res?.headers.get("Vary")).toBe("Access-Control-Request-Headers");
  });

  test("preflight without requested headers uses the default list", async () => {
    const wrapped = withMiddleware(
      [corsMiddleware()],
      () => new Response("ok"),
    );
    const res = await wrapped(
      new Request("http://localhost/api", { method: "OPTIONS" }),
    );
    expect(res?.headers.get("Access-Control-Allow-Headers")).toBe(
      "Content-Type, Authorization",
    );
    expect(res?.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  test("a preflight response is not shared between requests", async () => {
    const wrapped = withMiddleware(
      [corsMiddleware()],
      () => new Response("ok"),
    );
    const first = await wrapped(
      new Request("http://localhost/api", {
        method: "OPTIONS",
        headers: { "Access-Control-Request-Headers": "x-a" },
      }),
    );
    const second = await wrapped(
      new Request("http://localhost/api", { method: "OPTIONS" }),
    );
    first?.headers.set("x-mutated", "1");
    expect(second?.headers.has("x-mutated")).toBe(false);
    expect(second?.headers.get("Access-Control-Allow-Headers")).toBe(
      "Content-Type, Authorization",
    );
  });
});

describe("headersMiddleware", () => {
  test("sets configured headers on the response", async () => {
    const wrapped = withMiddleware(
      [headersMiddleware({ "X-App": "steambun" })],
      () => new Response("ok"),
    );
    const res = await wrapped(new Request("http://localhost/api"));
    expect(res?.headers.get("X-App")).toBe("steambun");
  });
});

describe("composeServerMiddleware", () => {
  test("puts cors and headers ahead of the user's middleware", () => {
    const user: Middleware = (_req, next) => next();
    const chain = composeServerMiddleware(
      { cors: true, headers: { "x-a": "1" } },
      [user],
    );
    expect(chain).toHaveLength(3);
    expect(chain[2]).toBe(user);
  });

  test("a non-function entry throws instead of being skipped", () => {
    expect(() =>
      composeServerMiddleware({}, [() => undefined, "./auth"]),
    ).toThrow("middleware[1] must be a function");
  });
});

describe("createErrorHandler", () => {
  test("dev handler returns undefined so Bun can render the overlay", () => {
    const error = createErrorHandler(true);
    expect(error(new Error("boom"))).toBeUndefined();
  });

  test("prod handler returns JSON 500", async () => {
    const error = createErrorHandler(false);
    const res = error(new Error("boom"));
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(500);
    expect(await (res as Response).json()).toEqual({
      error: "Internal Server Error",
    });
  });
});

describe("serveWithPortRetry", () => {
  test("retries the next port when the first is taken", () => {
    const occupied = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const occupiedPort = occupied.port as number;
    const servers: Bun.Server<undefined>[] = [occupied];
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const server = serveWithPortRetry(
        { port: occupiedPort, fetch: () => new Response("ok") },
        { label: "dev" },
      );
      servers.push(server);
      expect(server.port).toBeGreaterThan(occupiedPort);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      for (const server of servers) server.stop(true);
    }
  });

  test("strictPort rethrows instead of retrying", () => {
    const occupied = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const occupiedPort = occupied.port as number;
    try {
      expect(() =>
        serveWithPortRetry(
          { port: occupiedPort, fetch: () => new Response("ok") },
          { strictPort: true },
        ),
      ).toThrow(
        `[steambun] port ${occupiedPort} is already in use (strictPort)`,
      );
    } finally {
      occupied.stop(true);
    }
  });

  test("throws a steambun error naming the range once attempts run out", () => {
    const occupied = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const occupiedPort = occupied.port as number;
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() =>
        serveWithPortRetry(
          { port: occupiedPort, fetch: () => new Response("ok") },
          { attempts: 1 },
        ),
      ).toThrow(
        `[steambun] no free port in ${occupiedPort}-${occupiedPort} (1 tried)`,
      );
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      occupied.stop(true);
    }
  });

  test("attempts counts total ports tried", () => {
    const occupied = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const occupiedPort = occupied.port as number;
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    let server: Bun.Server<undefined> | undefined;
    try {
      server = serveWithPortRetry(
        { port: occupiedPort, fetch: () => new Response("ok") },
        { attempts: 2 },
      );
      expect(server.port).toBe(occupiedPort + 1);
    } finally {
      warnSpy.mockRestore();
      server?.stop(true);
      occupied.stop(true);
    }
  });

  test("a non-EADDRINUSE error is rethrown unchanged", () => {
    expect(() =>
      serveWithPortRetry(
        {
          port: 5173,
          hostname: "not a real hostname",
          fetch: () => new Response("ok"),
        },
        {},
      ),
    ).toThrow();
  });
});

describe("listPublicFiles", () => {
  const urlPaths = async (dir: string) =>
    (await listPublicFiles(dir)).map((f) => f.urlPath).sort();

  test("lists nested files by URL path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-public-"));
    writeFileSync(join(dir, "favicon.ico"), "icon");
    mkdirSync(join(dir, "img"));
    writeFileSync(join(dir, "img", "logo.png"), "png");
    expect(await urlPaths(dir)).toEqual(["/favicon.ico", "/img/logo.png"]);
  });

  test("missing publicDir is a no-op", async () => {
    expect(await urlPaths(join(tmpdir(), "steambun-no-public"))).toEqual([]);
  });

  test("filenames with spaces are percent-encoded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-public-"));
    writeFileSync(join(dir, "my file.png"), "png");
    expect(await urlPaths(dir)).toEqual(["/my%20file.png"]);
  });

  test("dotfiles and nested dotfile directories are excluded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-public-"));
    writeFileSync(join(dir, ".DS_Store"), "junk");
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "config"), "junk");
    expect(await urlPaths(dir)).toEqual([]);
  });

  test("a stray .html file is still listed but warns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-public-"));
    writeFileSync(join(dir, "stray.html"), "<h1>stray</h1>");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await urlPaths(dir)).toEqual(["/stray.html"]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("HTML under publicDir is not an app entry"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test(".env and .env.local are excluded and each warns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-public-"));
    writeFileSync(join(dir, ".env"), "SECRET=1");
    writeFileSync(join(dir, ".env.local"), "SECRET=2");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await urlPaths(dir)).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(".env — .env files should not be published"),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          ".env.local — .env files should not be published",
        ),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
