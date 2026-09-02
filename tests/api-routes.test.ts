import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileToApiPaths, loadApiRoutes } from "../src/runtime/api-routes";

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
