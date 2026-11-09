import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDefaults } from "../src/config/loader";
import type { ResolvedConfig } from "../src/config/types";
import { createApp } from "../src/runtime/app";

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function baseConfig(
  root: string,
  overrides: Partial<Parameters<typeof resolveDefaults>[0]> = {},
): ResolvedConfig {
  return resolveDefaults(
    { publicDir: false, ...overrides },
    { root, command: "build", mode: "production", configFile: null },
  );
}

function writeApiFixture(root: string): string {
  const apiDir = join(root, "api");
  mkdirSync(apiDir, { recursive: true });
  writeFileSync(
    join(apiDir, "health.ts"),
    `export const GET = () => Response.json({ ok: true });\n`,
  );
  mkdirSync(join(apiDir, "users"));
  writeFileSync(
    join(apiDir, "users", "[id].ts"),
    `export const GET = (req) => Response.json({ id: req.params.id });
export const DELETE = () => new Response(null, { status: 204 });
`,
  );
  writeFileSync(
    join(apiDir, "echo.ts"),
    `export default (req) => Response.json({ method: req.method });\n`,
  );
  return apiDir;
}

function writeThrowingApiFixture(root: string): string {
  const apiDir = join(root, "api");
  mkdirSync(apiDir, { recursive: true });
  writeFileSync(
    join(apiDir, "boom.ts"),
    `export const GET = () => { throw new Error("boom"); };\n`,
  );
  return apiDir;
}

describe("createApp — api routes", () => {
  test("dispatches params, 404s on unhandled methods (Bun's own router semantics), and reaches the default export", async () => {
    const root = tmpDir("steambun-app-api-");
    const apiDir = writeApiFixture(root);
    const config = baseConfig(root, { api: "api" });
    const app = await createApp({ config, mode: "dev" });
    try {
      expect(config.api).toBe(apiDir);
      expect(app.collisions).toEqual([]);

      const userRes = await app.fetch(
        new Request("http://localhost/api/users/42"),
      );
      expect(await userRes.json()).toEqual({ id: "42" });

      // Bun 404s (not 405s) an unmapped method on a method-map route.
      const healthRes = await app.fetch(
        new Request("http://localhost/api/health", { method: "POST" }),
      );
      expect(healthRes.status).toBe(404);

      const echoRes = await app.fetch(
        new Request("http://localhost/api/echo", { method: "PUT" }),
      );
      expect(await echoRes.json()).toEqual({ method: "PUT" });
    } finally {
      app.close();
    }
  });

  test("runs config.middleware and server.cors for api routes", async () => {
    const root = tmpDir("steambun-app-mw-");
    writeApiFixture(root);
    const config = baseConfig(root, {
      api: "api",
      server: { cors: true },
      middleware: [
        async (_req: Request, next: () => unknown) => {
          const res = (await next()) as Response | undefined;
          if (!res) return res;
          const out = new Response(res.body, res);
          out.headers.set("x-mw", "1");
          return out;
        },
      ],
    });
    const app = await createApp({ config, mode: "dev" });
    try {
      const preflight = await app.fetch(
        new Request("http://localhost/api/echo", { method: "OPTIONS" }),
      );
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");

      const res = await app.fetch(new Request("http://localhost/api/health"));
      expect(res.headers.get("x-mw")).toBe("1");
    } finally {
      app.close();
    }
  });

  test("html bundle-shaped routes serve their real content, not a blank 200", async () => {
    const root = tmpDir("steambun-app-html-");
    const config = baseConfig(root);
    const app = await createApp({
      config,
      mode: "dev",
      htmlRoutes: {
        "/": new Response("<html>hi</html>", {
          headers: { "content-type": "text/html" },
        }),
      },
    });
    try {
      const res = await app.fetch(new Request("http://localhost/"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toBe("<html>hi</html>");
    } finally {
      app.close();
    }
  });
});

describe("createApp — preview mode", () => {
  function previewFixture() {
    const root = tmpDir("steambun-app-preview-");
    const outDir = join(root, "dist");
    mkdirSync(join(outDir, "assets"), { recursive: true });
    writeFileSync(join(outDir, "index.html"), "<html>home</html>");
    writeFileSync(join(outDir, "assets", "x.js"), "console.log('x')");
    return { root, outDir };
  }

  test("serves root, assets, and the SPA fallback", async () => {
    const { root, outDir } = previewFixture();
    const config = baseConfig(root, { appType: "spa" });
    const app = await createApp({ config, mode: "preview", outDir });
    try {
      const home = await app.fetch(new Request("http://localhost/"));
      expect(home.status).toBe(200);

      const asset = await app.fetch(
        new Request("http://localhost/assets/x.js"),
      );
      expect(asset.status).toBe(200);

      const fallback = await app.fetch(
        new Request("http://localhost/nonexistent"),
      );
      expect(fallback.status).toBe(200);
    } finally {
      app.close();
    }
  });

  test("fetch() keeps a protocol-relative path on the app's own server", async () => {
    const { root, outDir } = previewFixture();
    const other = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("other-server"),
    });
    const app = await createApp({
      config: baseConfig(root, { appType: "spa" }),
      mode: "preview",
      outDir,
    });
    try {
      const res = await app.fetch(
        new Request(`http://localhost//127.0.0.1:${other.port}/x`),
      );
      expect(await res.text()).not.toBe("other-server");
    } finally {
      app.close();
      other.stop(true);
    }
  });

  test("mpa returns 404 on a miss", async () => {
    const { root, outDir } = previewFixture();
    const config = baseConfig(root, { appType: "mpa" });
    const app = await createApp({ config, mode: "preview", outDir });
    try {
      const fallback = await app.fetch(
        new Request("http://localhost/nonexistent"),
      );
      expect(fallback.status).toBe(404);
    } finally {
      app.close();
    }
  });
});

describe("createApp — preview rebuilds", () => {
  test("cache: false picks up a rewritten and a deleted file", async () => {
    const root = tmpDir("steambun-app-rebuild-");
    const outDir = join(root, "dist");
    mkdirSync(outDir);
    writeFileSync(join(outDir, "index.html"), "<html>v1</html>");
    writeFileSync(join(outDir, "gone.txt"), "here");
    const config = baseConfig(root, { appType: "mpa" });
    const fresh = await createApp({
      config,
      mode: "preview",
      outDir,
      cache: false,
    });
    const text = async (app: typeof fresh, path: string) => {
      const res = await app.fetch(new Request(`http://localhost${path}`));
      return [res.status, await res.text()];
    };
    try {
      expect(await text(fresh, "/")).toEqual([200, "<html>v1</html>"]);
      expect(await text(fresh, "/gone.txt")).toEqual([200, "here"]);

      writeFileSync(join(outDir, "index.html"), "<html>v2 longer</html>");
      rmSync(join(outDir, "gone.txt"));

      expect(await text(fresh, "/")).toEqual([200, "<html>v2 longer</html>"]);
      expect((await text(fresh, "/gone.txt"))[0]).toBe(404);
    } finally {
      fresh.close();
    }
  });
});

describe("createApp — unmatched /api", () => {
  const fixture = () => {
    const root = tmpDir("steambun-app-api404-");
    writeApiFixture(root);
    const outDir = join(root, "dist");
    mkdirSync(outDir);
    writeFileSync(join(outDir, "index.html"), "<html>spa</html>");
    return { root, outDir };
  };
  const get = async (
    app: { fetch(r: Request): Promise<Response> },
    p: string,
  ) => {
    const res = await app.fetch(new Request(`http://localhost${p}`));
    return {
      status: res.status,
      type: res.headers.get("content-type"),
      text: await res.text(),
    };
  };

  test.each(["spa", "mpa"] as const)(
    "preview (%s): /api and /api/* misses are a JSON 404; other paths keep their fallback",
    async (appType) => {
      const { root, outDir } = fixture();
      const config = baseConfig(root, { api: "api", appType });
      const app = await createApp({ config, mode: "preview", outDir });
      try {
        for (const path of ["/api/nope", "/api/users/1/extra", "/api"]) {
          const res = await get(app, path);
          expect(res.status).toBe(404);
          expect(res.type).toContain("application/json");
          expect(JSON.parse(res.text)).toEqual({ error: "Not Found" });
        }
        expect((await get(app, "/api/health")).status).toBe(200);
        const other = await get(app, "/somewhere");
        expect(other.status).toBe(appType === "spa" ? 200 : 404);
        if (appType === "spa") expect(other.text).toBe("<html>spa</html>");
      } finally {
        app.close();
      }
    },
  );

  test("dev: the same JSON 404 beats the HTML catch-all, which still serves everything else", async () => {
    const { root } = fixture();
    const config = baseConfig(root, { api: "api" });
    const app = await createApp({
      config,
      mode: "dev",
      htmlRoutes: {
        "/*": new Response("<html>spa</html>", {
          headers: { "content-type": "text/html" },
        }),
      },
    });
    try {
      const miss = await get(app, "/api/nope");
      expect(miss.status).toBe(404);
      expect(JSON.parse(miss.text)).toEqual({ error: "Not Found" });
      expect((await get(app, "/page")).text).toBe("<html>spa</html>");
    } finally {
      app.close();
    }
  });

  test("a catch-all route file keeps its own handler, and without `api` nothing is reserved", async () => {
    const root = tmpDir("steambun-app-api404-catch-");
    const apiDir = join(root, "api");
    mkdirSync(apiDir);
    writeFileSync(
      join(apiDir, "[[...rest]].ts"),
      `export default () => Response.json({ caught: true });\n`,
    );
    const outDir = join(root, "dist");
    mkdirSync(outDir);
    writeFileSync(join(outDir, "index.html"), "<html>spa</html>");
    const withApi = await createApp({
      config: baseConfig(root, { api: "api" }),
      mode: "preview",
      outDir,
    });
    const withoutApi = await createApp({
      config: baseConfig(root),
      mode: "preview",
      outDir,
    });
    try {
      expect(JSON.parse((await get(withApi, "/api/x")).text)).toEqual({
        caught: true,
      });
      expect((await get(withoutApi, "/api/x")).text).toBe("<html>spa</html>");
    } finally {
      withApi.close();
      withoutApi.close();
    }
  });

  test("publicDir files under /api are not served in dev, matching preview", async () => {
    const { root } = fixture();
    mkdirSync(join(root, "public", "api"), { recursive: true });
    writeFileSync(join(root, "public", "api", "data.json"), "{}");
    writeFileSync(join(root, "public", "ok.txt"), "ok");
    const app = await createApp({
      config: baseConfig(root, { api: "api", publicDir: "public" }),
      mode: "dev",
    });
    try {
      expect((await get(app, "/api/data.json")).status).toBe(404);
      expect((await get(app, "/ok.txt")).text).toBe("ok");
    } finally {
      app.close();
    }
  });
});

describe("createApp — middleware scope", () => {
  test("cors, headers, and middleware wrap api routes and the proxy, not preview's static files", async () => {
    const root = tmpDir("steambun-app-scope-");
    writeApiFixture(root);
    const outDir = join(root, "dist");
    mkdirSync(outDir);
    writeFileSync(join(outDir, "index.html"), "<html></html>");
    const seen: string[] = [];
    const config = baseConfig(root, {
      api: "api",
      server: { cors: true, headers: { "x-h": "1" } },
      middleware: [
        (
          req: Request,
          next: () => Response | Promise<Response | undefined> | undefined,
        ) => {
          seen.push(new URL(req.url).pathname);
          return next();
        },
      ],
    });
    const app = await createApp({ config, mode: "preview", outDir });
    try {
      const api = await app.fetch(new Request("http://localhost/api/health"));
      expect(api.headers.get("x-h")).toBe("1");
      expect(api.headers.get("access-control-allow-origin")).toBe("*");

      const page = await app.fetch(new Request("http://localhost/"));
      expect(page.status).toBe(200);
      expect(page.headers.get("x-h")).toBeNull();
      expect(page.headers.get("access-control-allow-origin")).toBeNull();
      expect(seen).toEqual(["/api/health"]);
    } finally {
      app.close();
    }
  });
});

describe("createApp — publicDir", () => {
  function publicFixture() {
    const root = tmpDir("steambun-app-public-");
    mkdirSync(join(root, "public"));
    writeFileSync(join(root, "public", "robots.txt"), "source");
    const outDir = join(root, "dist");
    mkdirSync(outDir);
    writeFileSync(join(outDir, "index.html"), "<html></html>");
    writeFileSync(join(outDir, "robots.txt"), "built");
    return { root, outDir };
  }

  test("dev serves files from publicDir, preview serves the copy in outDir", async () => {
    const { root, outDir } = publicFixture();
    const config = baseConfig(root, { publicDir: "public" });
    const read = async (app: Awaited<ReturnType<typeof createApp>>) => {
      try {
        return await (
          await app.fetch(new Request("http://localhost/robots.txt"))
        ).text();
      } finally {
        app.close();
      }
    };
    expect(await read(await createApp({ config, mode: "dev" }))).toBe("source");
    expect(
      await read(await createApp({ config, mode: "preview", outDir })),
    ).toBe("built");
  });
});

describe("createApp — dev error surface", () => {
  test("dev mode: a thrown API handler becomes a visible 500 JSON", async () => {
    const root = tmpDir("steambun-app-dev-err-");
    writeThrowingApiFixture(root);
    const config = baseConfig(root, { api: "api" });
    const app = await createApp({ config, mode: "dev" });
    try {
      const res = await app.fetch(new Request("http://localhost/api/boom"));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("boom");
      expect(typeof body.stack).toBe("string");
      expect(body.method).toBe("GET");
      expect(body.path).toBe("/api/boom");
      expect(body.route).toBe(join("api", "boom.ts"));
    } finally {
      app.close();
    }
  });

  test("preview mode: the same route is not wrapped, so a throw surfaces as Bun's own 500", async () => {
    const root = tmpDir("steambun-app-dev-err-preview-");
    writeThrowingApiFixture(root);
    const outDir = join(root, "dist");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "index.html"), "<html></html>");
    const config = baseConfig(root, { api: "api" });
    const app = await createApp({ config, mode: "preview", outDir });
    try {
      // Preview has no wrapDevErrors; Bun's `error` hook returns the generic 500.
      const res = await app.fetch(new Request("http://localhost/api/boom"));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Internal Server Error" });
    } finally {
      app.close();
    }
  });
});

describe("createApp — routeTable", () => {
  test("lists html, public, api, and proxy routes sorted by path", async () => {
    const root = tmpDir("steambun-app-routes-");
    writeApiFixture(root);
    mkdirSync(join(root, "public"));
    writeFileSync(join(root, "public", "favicon.ico"), "icon");
    const config = baseConfig(root, {
      api: "api",
      publicDir: "public",
      server: { proxy: { "/legacy": "http://localhost:9999" } },
    });
    const app = await createApp({
      config,
      mode: "dev",
      htmlRoutes: { "/": {} },
    });

    const table = app.routeTable();
    const byPath = Object.fromEntries(table.map((row) => [row.path, row]));

    expect(byPath["/"]?.kind).toBe("html");
    expect(byPath["/favicon.ico"]?.kind).toBe("public");
    expect(byPath["/favicon.ico"]?.source).toBe(join("public", "favicon.ico"));
    expect(byPath["/api/health"]?.kind).toBe("api");
    expect(byPath["/api/users/:id"]?.methods.sort()).toEqual(["DELETE", "GET"]);
    expect(byPath["/legacy"]?.kind).toBe("proxy");
    expect(byPath["/legacy/*"]?.kind).toBe("proxy");

    const paths = table.map((row) => row.path);
    expect(paths).toEqual([...paths].sort());
  });
});
