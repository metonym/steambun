import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAliasPlugin } from "../src/util/alias";
import { createServerBoundaryPlugin } from "../src/util/server-boundary";
import { createViteSuffixPlugin } from "../src/util/vite-suffix-plugin";

function project(main: string): string {
  const root = mkdtempSync(join(tmpdir(), "steambun-boundary-"));
  const files: Record<string, string> = {
    "src/main.ts": main,
    "src/db.server.ts": "export const db = 'secret';",
    "src/shared.ts": "export const shared = 1;",
    "src/api/users.ts":
      "export type User = { id: string }; export const GET = () => 1;",
    "node_modules/lib/index.js": "export * from './impl.server.js';",
    "node_modules/lib/impl.server.js": "export const lib = 1;",
    "node_modules/pkg/entry.server.js": "export const pkg = 1;",
  };
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

async function bundle(main: string) {
  const root = project(main);
  const result = await Bun.build({
    entrypoints: [join(root, "src/main.ts")],
    throw: false,
    plugins: [
      createServerBoundaryPlugin(root, "./src/api", { "@": "./src" }),
      createAliasPlugin({ "@": "./src" }, root),
      createViteSuffixPlugin({ "@": "./src" }, root),
    ],
  });
  return {
    success: result.success,
    errors: result.logs.map((log) => String(log)).join("\n"),
  };
}

describe("createServerBoundaryPlugin", () => {
  test("names the importer of a .server module", async () => {
    const { success, errors } = await bundle(
      'import { db } from "./db.server"; console.log(db);',
    );
    expect(success).toBe(false);
    expect(errors).toContain(
      '[steambun] src/main.ts imports "./db.server", a server-only module',
    );
  });

  test("checks .server imports before an alias resolves them", async () => {
    const { success, errors } = await bundle(
      'import { db } from "@/db.server.ts"; console.log(db);',
    );
    expect(success).toBe(false);
    expect(errors).toContain('imports "@/db.server.ts"');
  });

  test("rejects a module under the api dir", async () => {
    const { success, errors } = await bundle(
      'import { GET } from "./api/users"; console.log(GET);',
    );
    expect(success).toBe(false);
    expect(errors).toContain(
      "[steambun] src/api/users.ts is server-only (under `api`)",
    );
  });

  test("allows type-only imports and ordinary modules", async () => {
    const { success, errors } = await bundle(
      'import type { User } from "./api/users";\nimport type { db } from "./db.server";\nimport { shared } from "./shared";\nconst u: User = { id: "1" }; console.log(u, shared as unknown as typeof db);',
    );
    expect(errors).toBe("");
    expect(success).toBe(true);
  });

  test("leaves a dependency's own .server files alone", async () => {
    const { success } = await bundle(
      'import { lib } from "lib"; import { pkg } from "pkg/entry.server.js"; console.log(lib, pkg);',
    );
    expect(success).toBe(true);
  });

  test.each([
    ["?raw", "./db.server.ts?raw"],
    ["?url", "./db.server.ts?url"],
    ["?inline on an extensionless specifier", "./db.server?inline"],
    ["an aliased ?raw", "@/db.server.ts?raw"],
  ])("rejects a .server module reached through %s", async (_, spec) => {
    const { success, errors } = await bundle(
      `import x from ${JSON.stringify(spec)}; console.log(x);`,
    );
    expect(success).toBe(false);
    expect(errors).toContain("server-only");
  });

  test("rejects an api module reached through ?raw", async () => {
    const { success, errors } = await bundle(
      'import x from "./api/users.ts?raw"; console.log(x);',
    );
    expect(success).toBe(false);
    expect(errors).toContain("server-only");
  });

  test("still allows ?raw of an ordinary file", async () => {
    const { success, errors } = await bundle(
      'import x from "./shared.ts?raw"; console.log(x);',
    );
    expect(errors).toBe("");
    expect(success).toBe(true);
  });
});
