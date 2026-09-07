import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HtmlEntry } from "../src/dev/discover";
import { generateRoutesDts, writeRoutesDts } from "../src/routes-dts";

describe("generateRoutesDts", () => {
  test("emits typed routes and pages, including catch-all params", () => {
    const htmlEntries: HtmlEntry[] = [
      { file: "/project/index.html", routePath: "/*", isCatchAll: true },
      { file: "/project/about.html", routePath: "/about", isCatchAll: false },
    ];

    const source = generateRoutesDts({
      dtsDir: "/project/.steambun",
      apiEntries: [
        { file: "/project/src/api/health.ts", paths: ["/api/health"] },
        {
          file: "/project/src/api/users/[id].ts",
          paths: ["/api/users/:id"],
        },
        {
          file: "/project/src/api/docs/[...slug].ts",
          paths: ["/api/docs/*"],
        },
        {
          file: "/project/src/api/opt/[[...slug]].ts",
          paths: ["/api/opt", "/api/opt/*"],
        },
        {
          file: "/project/src/api/chat/[room].ts",
          paths: ["/api/chat/:room"],
          hasWebsocket: true,
        },
      ],
      htmlEntries,
      appType: "spa",
    });

    expect(source).toContain('import type * as R0 from "../src/api/health";');
    expect(source).toContain(
      'import type * as R1 from "../src/api/users/[id]";',
    );
    expect(source).toContain(
      'import type * as R2 from "../src/api/docs/[...slug]";',
    );
    expect(source).toContain(
      'import type * as R3 from "../src/api/opt/[[...slug]]";',
    );
    expect(source).toContain(
      'import type * as R4 from "../src/api/chat/[room]";',
    );

    expect(source).toContain(
      '"/api/health": { params: {}; module: typeof R0; websocket: false };',
    );
    expect(source).toContain(
      '"/api/users/:id": { params: { "id": string }; module: typeof R1; websocket: false };',
    );
    // A wildcard segment carries no named param, matching real Bun.serve
    // (req.params is empty for a `/*` match).
    expect(source).toContain(
      '"/api/docs/*": { params: {}; module: typeof R2; websocket: false };',
    );
    expect(source).toContain(
      '"/api/opt": { params: {}; module: typeof R3; websocket: false };',
    );
    expect(source).toContain(
      '"/api/opt/*": { params: {}; module: typeof R3; websocket: false };',
    );
    expect(source).toContain(
      '"/api/chat/:room": { params: { "room": string }; module: typeof R4; websocket: true };',
    );

    // Root index.html in SPA mode is "/*" — stripped to "/" for the page key.
    expect(source).toContain('"/": {};');
    expect(source).toContain('"/about": {};');
    expect(source).toContain('declare module "steambun/client"');
  });
});

describe("writeRoutesDts", () => {
  test("writes .steambun/routes.d.ts for a real project", async () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-routes-dts-"));
    mkdirSync(join(root, "api", "users"), { recursive: true });
    writeFileSync(
      join(root, "api", "users", "[id].ts"),
      "export const GET = () => Response.json({});\n",
    );
    const htmlEntries: HtmlEntry[] = [
      { file: join(root, "index.html"), routePath: "/*", isCatchAll: true },
    ];

    const path = await writeRoutesDts(
      root,
      join(root, "api"),
      htmlEntries,
      "mpa",
    );
    const content = readFileSync(path, "utf8");

    expect(content).toContain('"/api/users/:id"');
    expect(content).toContain('"/": {};');
  });

  test("marks a route with a real `export const websocket` as websocket: true", async () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-routes-dts-"));
    mkdirSync(join(root, "api", "chat"), { recursive: true });
    writeFileSync(
      join(root, "api", "chat", "[room].ts"),
      "export const websocket = { open() {} };\n",
    );
    writeFileSync(
      join(root, "api", "health.ts"),
      "export const GET = () => Response.json({});\n",
    );

    const path = await writeRoutesDts(root, join(root, "api"), [], "mpa");
    const content = readFileSync(path, "utf8");

    expect(content).toContain(
      '"/api/chat/:room": { params: { "room": string }; module: typeof R0; websocket: true };',
    );
    expect(content).toContain(
      '"/api/health": { params: {}; module: typeof R1; websocket: false };',
    );
  });
});
