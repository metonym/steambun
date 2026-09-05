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
});
