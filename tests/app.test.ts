import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
  test("dispatches params, 405s on unhandled methods, and reaches the default export", async () => {
    const root = tmpDir("steambun-app-api-");
    const apiDir = writeApiFixture(root);
    const config = baseConfig(root, { api: "api" });
    const app = await createApp({ config, mode: "dev" });
    expect(config.api).toBe(apiDir);
    expect(app.collisions).toEqual([]);

    const userRes = await app.fetch(
      new Request("http://localhost/api/users/42"),
    );
    expect(await userRes.json()).toEqual({ id: "42" });

    const healthRes = await app.fetch(
      new Request("http://localhost/api/health", { method: "POST" }),
    );
    expect(healthRes.status).toBe(405);

    const echoRes = await app.fetch(
      new Request("http://localhost/api/echo", { method: "PUT" }),
    );
    expect(await echoRes.json()).toEqual({ method: "PUT" });
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

    const preflight = await app.fetch(
      new Request("http://localhost/api/echo", { method: "OPTIONS" }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const res = await app.fetch(new Request("http://localhost/api/health"));
    expect(res.headers.get("x-mw")).toBe("1");
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

    const home = await app.fetch(new Request("http://localhost/"));
    expect(home.status).toBe(200);

    const asset = await app.fetch(new Request("http://localhost/assets/x.js"));
    expect(asset.status).toBe(200);

    const fallback = await app.fetch(
      new Request("http://localhost/nonexistent"),
    );
    expect(fallback.status).toBe(200);
  });

  test("mpa returns 404 on a miss", async () => {
    const { root, outDir } = previewFixture();
    const config = baseConfig(root, { appType: "mpa" });
    const app = await createApp({ config, mode: "preview", outDir });

    const fallback = await app.fetch(
      new Request("http://localhost/nonexistent"),
    );
    expect(fallback.status).toBe(404);
  });
});

describe("createApp — dev error surface", () => {
  test("dev mode: a thrown API handler becomes a visible 500 JSON", async () => {
    const root = tmpDir("steambun-app-dev-err-");
    writeThrowingApiFixture(root);
    const config = baseConfig(root, { api: "api" });
    const app = await createApp({ config, mode: "dev" });

    const res = await app.fetch(new Request("http://localhost/api/boom"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("boom");
    expect(typeof body.stack).toBe("string");
    expect(body.method).toBe("GET");
    expect(body.path).toBe("/api/boom");
    expect(body.route).toBe(join("api", "boom.ts"));
  });

  test("dev mode: Accept: text/html returns an alert dialog", async () => {
    const root = tmpDir("steambun-app-dev-err-html-");
    writeThrowingApiFixture(root);
    const config = baseConfig(root, { api: "api" });
    const app = await createApp({ config, mode: "dev" });

    const res = await app.fetch(
      new Request("http://localhost/api/boom", {
        headers: { accept: "text/html" },
      }),
    );
    expect(res.status).toBe(500);
    const html = await res.text();
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("<button");
  });

  test("preview mode: the same route is not wrapped", async () => {
    const root = tmpDir("steambun-app-dev-err-preview-");
    writeThrowingApiFixture(root);
    const outDir = join(root, "dist");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "index.html"), "<html></html>");
    const config = baseConfig(root, { api: "api" });
    const app = await createApp({ config, mode: "preview", outDir });

    await expect(
      app.fetch(new Request("http://localhost/api/boom")),
    ).rejects.toThrow("boom");
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
    expect(byPath["/api/health"]?.kind).toBe("api");
    expect(byPath["/api/users/:id"]?.methods.sort()).toEqual(["DELETE", "GET"]);
    expect(byPath["/legacy"]?.kind).toBe("proxy");
    expect(byPath["/legacy/*"]?.kind).toBe("proxy");

    const paths = table.map((row) => row.path);
    expect(paths).toEqual([...paths].sort());
  });
});
