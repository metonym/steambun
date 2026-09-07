import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateEnvPluginSource } from "../src/dev/env-plugin";
import { generateBunfigSource } from "../src/dev/synth";
import {
  corsMiddleware,
  createErrorHandler,
  headersMiddleware,
  serveWithPortRetry,
} from "../src/runtime/http";
import { withMiddleware } from "../src/runtime/middleware";
import { addPublicDirRoutes } from "../src/runtime/public-dir";
import { createAliasPlugin } from "../src/util/alias";

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

describe("createErrorHandler", () => {
  test("dev handler returns undefined so Bun can render the overlay", () => {
    const error = createErrorHandler(true);
    const orig = console.error;
    console.error = () => {};
    try {
      expect(error(new Error("boom"))).toBeUndefined();
    } finally {
      console.error = orig;
    }
  });

  test("prod handler returns JSON 500", async () => {
    const error = createErrorHandler(false);
    const orig = console.error;
    console.error = () => {};
    try {
      const res = error(new Error("boom"));
      expect(res).toBeInstanceOf(Response);
      expect((res as Response).status).toBe(500);
      expect(await (res as Response).json()).toEqual({
        error: "Internal Server Error",
      });
    } finally {
      console.error = orig;
    }
  });
});

describe("serveWithPortRetry", () => {
  test("retries the next port when the first is taken", () => {
    const occupied = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const servers: Bun.Server[] = [occupied];
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const server = serveWithPortRetry(
        { port: occupied.port, fetch: () => new Response("ok") },
        { label: "dev" },
      );
      servers.push(server);
      expect(server.port).toBeGreaterThan(occupied.port);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      for (const server of servers) server.stop(true);
    }
  });

  test("strictPort rethrows instead of retrying", () => {
    const occupied = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    try {
      expect(() =>
        serveWithPortRetry(
          { port: occupied.port, fetch: () => new Response("ok") },
          { strictPort: true },
        ),
      ).toThrow(
        `[steambun] port ${occupied.port} is already in use (strictPort)`,
      );
    } finally {
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

describe("addPublicDirRoutes", () => {
  test("registers files as exact routes and does not overwrite existing ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-public-"));
    writeFileSync(join(dir, "favicon.ico"), "icon");
    mkdirSync(join(dir, "img"));
    writeFileSync(join(dir, "img", "logo.png"), "png");
    const routes: Record<string, unknown> = {
      "/favicon.ico": "keep",
    };
    await addPublicDirRoutes(routes, dir);
    expect(routes["/favicon.ico"]).toBe("keep");
    expect(routes["/img/logo.png"]).toBeInstanceOf(Blob);
  });

  test("missing publicDir is a no-op", async () => {
    const routes: Record<string, unknown> = {};
    await addPublicDirRoutes(routes, join(tmpdir(), "steambun-no-public"));
    expect(routes).toEqual({});
  });
});

describe("createAliasPlugin", () => {
  test("rewrites @/ specifiers to the aliased directory", () => {
    const plugin = createAliasPlugin({ "@": "/project/src" }, "/project");
    let resolve:
      | ((args: { path: string }) => { path: string } | undefined)
      | undefined;
    plugin.setup({
      onResolve(_opts: unknown, cb: typeof resolve) {
        resolve = cb;
      },
    } as import("bun").PluginBuilder);
    expect(resolve?.({ path: "@/foo.ts" })).toEqual({
      path: join("/project/src", "foo.ts"),
    });
    expect(resolve?.({ path: "./local.ts" })).toBeUndefined();
  });
});

describe("generateBunfigSource", () => {
  test("writes plugins and a single env glob", () => {
    const source = generateBunfigSource(["./env-plugin.ts"], "PUBLIC_*");
    expect(source).toContain('plugins = ["./env-plugin.ts"]');
    expect(source).toContain('env = "PUBLIC_*"');
  });

  test("omits env when there is no single prefix", () => {
    expect(generateBunfigSource(["./env-plugin.ts"], undefined)).not.toContain(
      "env =",
    );
  });
});

describe("generateEnvPluginSource", () => {
  test("replaces user define keys, not only import.meta.env", () => {
    const source = generateEnvPluginSource({
      "import.meta.env.FOO": '"bar"',
      __APP_VERSION__: '"1"',
    });
    expect(source).toContain("__APP_VERSION__");
    expect(source).toContain("KEYS = Object.keys(DEFINES)");
  });
});
