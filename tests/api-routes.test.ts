import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileToApiPaths,
  listApiFileEntries,
  loadApiModules,
  loadApiRoutes,
} from "../src/runtime/api-routes";

describe("fileToApiPaths", () => {
  test("static files map under /api", () => {
    expect(fileToApiPaths("health.ts")).toEqual(["/api/health"]);
    expect(fileToApiPaths("index.ts")).toEqual(["/api"]);
    expect(fileToApiPaths("users/index.ts")).toEqual(["/api/users"]);
  });

  test("[id] becomes :id", () => {
    expect(fileToApiPaths("users/[id].ts")).toEqual(["/api/users/:id"]);
  });

  test("[...slug] becomes a wildcard", () => {
    expect(fileToApiPaths("docs/[...slug].ts")).toEqual(["/api/docs/*"]);
  });

  test("[[...slug]] registers the parent and a wildcard", () => {
    expect(fileToApiPaths("docs/[[...slug]].ts")).toEqual([
      "/api/docs",
      "/api/docs/*",
    ]);
    expect(fileToApiPaths("[[...slug]].ts")).toEqual(["/api", "/api/*"]);
  });
});

describe("loadApiRoutes", () => {
  test("mounts a [id] file on the Bun param route", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-api-"));
    mkdirSync(join(dir, "users"));
    writeFileSync(
      join(dir, "users", "[id].ts"),
      `export function GET() { return Response.json({ ok: true }); }\n`,
    );
    const routes = await loadApiRoutes(dir);
    expect(Object.keys(routes)).toEqual(["/api/users/:id"]);
    const handler = routes["/api/users/:id"] as { GET: () => Response };
    const res = handler.GET();
    expect(await res.json()).toEqual({ ok: true });
  });
});

function writeRoute(dir: string, rel: string, body: string): void {
  const file = join(dir, rel);
  const parent = file.slice(0, file.lastIndexOf("/"));
  if (parent && parent !== dir) mkdirSync(parent, { recursive: true });
  writeFileSync(file, body);
}

const HANDLER = (label: string) =>
  `export const GET = () => Response.json({ from: "${label}" });\n`;

describe("route collisions", () => {
  test("index.ts beats [[...slug]].ts for /api regardless of creation order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-api-"));
    writeRoute(dir, "[[...slug]].ts", HANDLER("catch-all"));
    writeRoute(dir, "index.ts", HANDLER("index"));

    const { routes, collisions } = await loadApiModules(dir);
    expect((routes["/api"] as Record<string, unknown>).GET).toBeDefined();
    const res = (routes["/api"] as { GET: () => Response }).GET();
    expect(await res.json()).toEqual({ from: "index" });
    expect(routes["/api/*"]).toBeDefined();

    expect(collisions).toEqual([
      { path: "/api", winner: "index.ts", loser: "[[...slug]].ts" },
    ]);
  });

  test("foo.ts vs foo/index.ts ties on specificity and resolves lexically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-api-"));
    writeRoute(dir, "foo.ts", HANDLER("foo-file"));
    writeRoute(dir, "foo/index.ts", HANDLER("foo-index"));

    const { routes, collisions } = await loadApiModules(dir);
    const res = (routes["/api/foo"] as { GET: () => Response }).GET();
    expect(await res.json()).toEqual({ from: "foo-file" });
    expect(collisions).toEqual([
      { path: "/api/foo", winner: "foo.ts", loser: "foo/index.ts" },
    ]);
  });

  test("no collisions for a clean tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-api-"));
    writeRoute(dir, "health.ts", HANDLER("health"));
    writeRoute(dir, "users/[id].ts", HANDLER("user"));

    const { collisions } = await loadApiModules(dir);
    expect(collisions).toEqual([]);
  });
});

describe("listApiFileEntries", () => {
  test("returns entries sorted by apiDir-relative path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-api-"));
    writeRoute(dir, "[[...slug]].ts", HANDLER("catch-all"));
    writeRoute(dir, "users/[id].ts", HANDLER("user"));
    writeRoute(dir, "health.ts", HANDLER("health"));
    writeRoute(dir, "index.ts", HANDLER("index"));

    const entries = await listApiFileEntries(dir);
    expect(entries.map((e) => e.rel)).toEqual([
      "[[...slug]].ts",
      "health.ts",
      "index.ts",
      "users/[id].ts",
    ]);
  });
});
