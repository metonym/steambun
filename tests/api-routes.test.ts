import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverApiFiles,
  hasWebsocketExport,
  loadApiRoutes,
} from "../src/runtime/api-routes";

function writeRoute(dir: string, rel: string, body: string): void {
  const file = join(dir, rel);
  const parent = file.slice(0, file.lastIndexOf("/"));
  if (parent && parent !== dir) mkdirSync(parent, { recursive: true });
  writeFileSync(file, body);
}

const HANDLER = (label: string) =>
  `export const GET = () => Response.json({ from: "${label}" });\n`;

async function pathsFor(rel: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "steambun-api-"));
  writeRoute(dir, rel, HANDLER("x"));
  return (await discoverApiFiles(dir)).files[0]!.paths;
}

describe("file name to route path", () => {
  test("static files map under /api", async () => {
    expect(await pathsFor("health.ts")).toEqual(["/api/health"]);
    expect(await pathsFor("index.ts")).toEqual(["/api"]);
    expect(await pathsFor("users/index.ts")).toEqual(["/api/users"]);
  });

  test("[id] becomes :id", async () => {
    expect(await pathsFor("users/[id].ts")).toEqual(["/api/users/:id"]);
  });

  test("[...slug] becomes a wildcard", async () => {
    expect(await pathsFor("docs/[...slug].ts")).toEqual(["/api/docs/*"]);
  });

  test("[[...slug]] registers the parent and a wildcard", async () => {
    expect(await pathsFor("docs/[[...slug]].ts")).toEqual([
      "/api/docs",
      "/api/docs/*",
    ]);
    expect(await pathsFor("[[...slug]].ts")).toEqual(["/api", "/api/*"]);
  });
});

describe("loadApiRoutes", () => {
  test("mounts a [id] file on the Bun param route", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-api-"));
    writeRoute(
      dir,
      "users/[id].ts",
      `export function GET() { return Response.json({ ok: true }); }\n`,
    );
    const { routes } = await loadApiRoutes(dir);
    expect(routes.map((r) => [r.path, r.file])).toEqual([
      ["/api/users/:id", "users/[id].ts"],
    ]);
    const handler = routes[0]!.handler as { GET: () => Response };
    expect(await handler.GET().json()).toEqual({ ok: true });
  });

  test("a default export serves every method; method exports win over it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-api-"));
    writeRoute(dir, "any.ts", "export default () => new Response('any');\n");
    writeRoute(
      dir,
      "both.ts",
      "export const GET = () => new Response('get');\nexport default () => new Response('any');\n",
    );
    const { routes } = await loadApiRoutes(dir);
    const byPath = Object.fromEntries(routes.map((r) => [r.path, r.handler]));
    expect(typeof byPath["/api/any"]).toBe("function");
    expect(Object.keys(byPath["/api/both"] as object)).toEqual(["GET"]);
  });

  test("a websocket export rides along with the file's paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-api-"));
    writeRoute(
      dir,
      "chat/[room].ts",
      "export const websocket = { message() {} };\n",
    );
    const { routes } = await loadApiRoutes(dir);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.handler).toBeUndefined();
    expect(routes[0]!.websocket).toBeDefined();
  });

  test("warns about a websocket export without handlers and about a file with no route exports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-api-"));
    writeRoute(dir, "bad.ts", "export const websocket = {};\n");
    writeRoute(dir, "typo.ts", "export const get = () => new Response('x');\n");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { routes } = await loadApiRoutes(dir);
      expect(routes).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("bad.ts: `websocket` export has no"),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("typo.ts: no route exports"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("catch-all placement", () => {
  test.each(["[...x]/foo.ts", "[[...x]]/foo.ts", "a/[...x]/b/[id].ts"])(
    "%s is rejected at discovery, naming the file",
    async (rel) => {
      const dir = mkdtempSync(join(tmpdir(), "steambun-api-catchall-"));
      writeRoute(dir, rel, HANDLER("x"));
      await expect(discoverApiFiles(dir)).rejects.toThrow(
        `api route ${rel}: catch-all`,
      );
    },
  );

  test("a catch-all directory's index file is still a valid last segment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-api-catchall-"));
    writeRoute(dir, "files/[...path]/index.ts", HANDLER("x"));
    expect((await discoverApiFiles(dir)).files[0]!.paths).toEqual([
      "/api/files/*",
    ]);
  });
});

describe("route collisions", () => {
  test("index.ts beats [[...slug]].ts for /api regardless of creation order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-api-"));
    writeRoute(dir, "[[...slug]].ts", HANDLER("catch-all"));
    writeRoute(dir, "index.ts", HANDLER("index"));

    const { routes, collisions } = await loadApiRoutes(dir);
    expect(routes.map((r) => [r.path, r.file]).sort()).toEqual([
      ["/api", "index.ts"],
      ["/api/*", "[[...slug]].ts"],
    ]);
    expect(collisions).toEqual([
      { path: "/api", winner: "index.ts", loser: "[[...slug]].ts" },
    ]);
  });

  test("foo.ts vs foo/index.ts ties on specificity and resolves lexically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-api-"));
    writeRoute(dir, "foo.ts", HANDLER("foo-file"));
    writeRoute(dir, "foo/index.ts", HANDLER("foo-index"));

    const { routes, collisions } = await loadApiRoutes(dir);
    expect(routes.map((r) => r.file)).toEqual(["foo.ts"]);
    expect(collisions).toEqual([
      { path: "/api/foo", winner: "foo.ts", loser: "foo/index.ts" },
    ]);
  });

  test("a.ts beats a.tsx and the report names both files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-api-"));
    writeRoute(dir, "a.tsx", HANDLER("tsx"));
    writeRoute(dir, "a.js", HANDLER("js"));
    writeRoute(dir, "a.ts", HANDLER("ts"));

    const { routes, collisions } = await loadApiRoutes(dir);
    expect(routes.map((r) => r.file)).toEqual(["a.ts"]);
    expect(collisions).toEqual([
      { path: "/api/a", winner: "a.ts", loser: "a.tsx" },
      { path: "/api/a", winner: "a.ts", loser: "a.js" },
    ]);
  });

  test("params with different names are the same route", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-api-"));
    writeRoute(dir, "users/[id].ts", HANDLER("id"));
    writeRoute(dir, "users/[slug].ts", HANDLER("slug"));

    const { routes, collisions } = await loadApiRoutes(dir);
    expect(routes.map((r) => r.file)).toEqual(["users/[id].ts"]);
    expect(collisions).toEqual([
      {
        path: "/api/users/:id",
        winner: "users/[id].ts",
        loser: "users/[slug].ts",
      },
    ]);
  });

  test("a shadowed file is never imported", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-api-"));
    writeRoute(dir, "a.ts", HANDLER("ts"));
    writeRoute(dir, "a.tsx", "throw new Error('loaded');\n");
    await expect(loadApiRoutes(dir)).resolves.toBeDefined();
  });

  test("no collisions for a clean tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-api-"));
    writeRoute(dir, "health.ts", HANDLER("health"));
    writeRoute(dir, "users/[id].ts", HANDLER("user"));

    const { collisions } = await loadApiRoutes(dir);
    expect(collisions).toEqual([]);
  });
});

describe("discoverApiFiles", () => {
  test("returns files sorted by apiDir-relative stem, then extension, with only the paths each owns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-api-"));
    writeRoute(dir, "[[...slug]].ts", HANDLER("catch-all"));
    writeRoute(dir, "users/[id].ts", HANDLER("user"));
    writeRoute(dir, "a.tsx", HANDLER("a"));
    writeRoute(dir, "a.ts", HANDLER("a"));
    writeRoute(dir, "index.ts", HANDLER("index"));

    const { files } = await discoverApiFiles(dir);
    expect(files.map((f) => [f.rel, f.paths])).toEqual([
      ["[[...slug]].ts", ["/api/*"]],
      ["a.ts", ["/api/a"]],
      ["index.ts", ["/api"]],
      ["users/[id].ts", ["/api/users/:id"]],
    ]);
  });

  test("skips declaration, test, spec, and _-prefixed files and directories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-api-"));
    writeRoute(dir, "health.ts", HANDLER("health"));
    writeRoute(dir, "health.d.ts", "export {};\n");
    writeRoute(dir, "health.test.ts", HANDLER("test"));
    writeRoute(dir, "health.spec.tsx", HANDLER("spec"));
    writeRoute(dir, "_helpers.ts", HANDLER("helper"));
    writeRoute(dir, "_internal/secret.ts", HANDLER("secret"));
    writeRoute(dir, "users/_util.ts", HANDLER("util"));
    writeRoute(dir, "users/[id].ts", HANDLER("user"));

    const { files } = await discoverApiFiles(dir);
    expect(files.map((f) => f.rel)).toEqual(["health.ts", "users/[id].ts"]);
  });
});

describe("hasWebsocketExport", () => {
  async function detect(source: string, name = "r.ts"): Promise<boolean> {
    const dir = mkdtempSync(join(tmpdir(), "steambun-api-"));
    writeRoute(dir, name, source);
    return hasWebsocketExport(join(dir, name));
  }

  test("sees every form of the export", async () => {
    expect(await detect("export const websocket = { open() {} };")).toBe(true);
    expect(await detect("export let websocket = { open() {} };")).toBe(true);
    expect(await detect("export function websocket() {}")).toBe(true);
    expect(
      await detect("const ws = { open() {} };\nexport { ws as websocket };"),
    ).toBe(true);
    expect(
      await detect("const websocket = { open() {} };\nexport { websocket };"),
    ).toBe(true);
    expect(await detect("export const websocket: Handlers = {};", "r.ts")).toBe(
      true,
    );
  });

  test("ignores mentions that are not exports", async () => {
    expect(await detect("const websocket = {};\nexport const GET = 1;")).toBe(
      false,
    );
    expect(
      await detect("// export const websocket = {}\nexport const GET = 1;"),
    ).toBe(false);
    expect(await detect("export const websockets = {};")).toBe(false);
    expect(await detect("not valid {{{")).toBe(false);
  });
});
