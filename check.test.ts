import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { check } from "./check.ts";
import { loadConfig } from "./config.ts";

const dirs: string[] = [];
afterAll(() =>
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true })),
);

async function app(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), "steambun-check-"));
  dirs.push(d);
  symlinkSync(
    join(import.meta.dir, "node_modules"),
    join(d, "node_modules"),
  );
  files = { "package.json": `{"name":"x"}`, ...files };
  for (const [f, s] of Object.entries(files)) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    writeFileSync(join(d, f), s);
  }
  return check(await loadConfig(d));
}

const html = `<script type="module" src="./ui/main.ts"></script>`;

test("a page that reaches bun:sqlite fails, with the chain", async () => {
  const ps = await app({
    "index.html": html,
    "ui/main.ts": `import { load } from "../core/db.ts"; load();`,
    "core/db.ts": `import { Database } from "bun:sqlite"; export const load = () => new Database();`,
  });
  expect(ps).toHaveLength(1);
  expect(ps[0]!.side).toBe("page");
  expect(ps[0]!.chain).toEqual(["index.html", "ui/main.ts", "core/db.ts"]);
});

test("type-only imports and shared modules are fine", async () => {
  const ps = await app({
    "index.html": html,
    "ui/main.ts": `import type { Row } from "../core/db.ts"; import { f } from "../shared/f.ts"; f(); export type X = Row;`,
    "shared/f.ts": `export const f = () => 1;`,
    "core/db.ts": `import "bun:sqlite"; export type Row = {};`,
  });
  expect(ps).toEqual([]);
});

test("a core that reaches steambun/ui or a component fails", async () => {
  const ps = await app({
    "index.html": html,
    "ui/main.ts": ``,
    "ui/App.tsx": `export default () => null;`,
    "core.ts": `import page from "./index.html"; import "steambun/ui"; import App from "./ui/App.tsx"; page; App;`,
  });
  expect(ps.map((p) => p.side)).toEqual(["core", "core"]);
});

test("with a core, the page is the HTML the core imports", async () => {
  const ps = await app({
    "app/index.html": `<script type="module" src="./main.ts"></script>`,
    "app/main.ts": `import "bun";`,
    "core/index.ts": `import page from "../app/index.html"; page;`,
  });
  expect(ps).toHaveLength(1);
  expect(ps[0]!.chain).toEqual(["app/index.html", "app/main.ts"]);
});
