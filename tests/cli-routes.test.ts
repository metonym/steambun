import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import type { RouteRow } from "../src/runtime/app";

function tmpProject(): string {
  const root = mkdtempSync(join(tmpdir(), "steambun-cli-routes-"));
  writeFileSync(join(root, "index.html"), "<html></html>");
  mkdirSync(join(root, "public"));
  writeFileSync(join(root, "public", "favicon.ico"), "icon");
  mkdirSync(join(root, "api"));
  writeFileSync(
    join(root, "api", "health.ts"),
    `export const GET = () => Response.json({ ok: true });\n`,
  );
  writeFileSync(
    join(root, "steambun.config.ts"),
    `export default {
  appType: "mpa",
  api: "./api",
  server: { proxy: { "/legacy": "http://localhost:9999" } },
};
`,
  );
  return root;
}

function tmpCollidingProject(): string {
  const root = mkdtempSync(join(tmpdir(), "steambun-cli-routes-collide-"));
  writeFileSync(join(root, "index.html"), "<html></html>");
  mkdirSync(join(root, "api"));
  writeFileSync(
    join(root, "api", "index.ts"),
    `export const GET = () => Response.json({ ok: true });\n`,
  );
  writeFileSync(
    join(root, "api", "[[...slug]].ts"),
    `export const GET = () => Response.json({ catchAll: true });\n`,
  );
  writeFileSync(
    join(root, "steambun.config.ts"),
    `export default { appType: "mpa", api: "./api" };\n`,
  );
  return root;
}

describe("steambun routes", () => {
  test("prints json rows for html, public, api, and proxy routes", async () => {
    const root = tmpProject();
    const logs: string[] = [];
    const orig = console.log;
    console.log = (msg: unknown) => {
      logs.push(String(msg));
    };
    try {
      await main(["routes", "--json", "--root", root]);
    } finally {
      console.log = orig;
    }
    const rows = JSON.parse(logs.join("\n")) as RouteRow[];
    const byPath = Object.fromEntries(rows.map((row) => [row.path, row]));

    expect(byPath["/"]?.kind).toBe("html");
    expect(byPath["/favicon.ico"]?.kind).toBe("public");
    expect(byPath["/api/health"]?.kind).toBe("api");
    expect(byPath["/legacy"]?.kind).toBe("proxy");
    expect(byPath["/legacy/*"]?.kind).toBe("proxy");
  });

  test("human output reports api route collisions", async () => {
    const root = tmpCollidingProject();
    const logs: string[] = [];
    const orig = console.log;
    console.log = (msg: unknown) => {
      logs.push(String(msg));
    };
    try {
      await main(["routes", "--root", root]);
    } finally {
      console.log = orig;
    }
    expect(logs.some((line) => line.includes("api route collision"))).toBe(
      true,
    );
  });

  test("--json output still parses as an array even with collisions", async () => {
    const root = tmpCollidingProject();
    const logs: string[] = [];
    const errs: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (msg: unknown) => {
      logs.push(String(msg));
    };
    console.error = (msg: unknown) => {
      errs.push(String(msg));
    };
    try {
      await main(["routes", "--json", "--root", root]);
    } finally {
      console.log = origLog;
      console.error = origError;
    }
    const rows = JSON.parse(logs[logs.length - 1]!) as RouteRow[];
    expect(Array.isArray(rows)).toBe(true);
    expect(errs.some((line) => line.includes("api route collision"))).toBe(
      true,
    );
  });
});
