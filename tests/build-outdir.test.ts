import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { build } from "../src/build/build";

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "steambun-outdir-"));
  writeFileSync(
    join(root, "index.html"),
    `<!doctype html><html><body><script type="module" src="./main.ts"></script></body></html>\n`,
  );
  writeFileSync(join(root, "main.ts"), `console.log("hi");\n`);
  return root;
}

describe("build() emptyOutDir", () => {
  test("a stale file in outDir is gone after build", async () => {
    const root = fixtureRoot();
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "stale.js"), "old");
    writeFileSync(
      join(root, "steambun.config.ts"),
      `export default { build: { server: false } };\n`,
    );

    await build({ root });

    expect(await Bun.file(join(root, "dist", "stale.js")).exists()).toBe(false);
  });

  test("build.emptyOutDir: false keeps a stale file", async () => {
    const root = fixtureRoot();
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "stale.js"), "old");
    writeFileSync(
      join(root, "steambun.config.ts"),
      `export default { build: { emptyOutDir: false, server: false } };\n`,
    );

    await build({ root });

    expect(await Bun.file(join(root, "dist", "stale.js")).exists()).toBe(true);
  });

  test("an outDir outside root warns and is not emptied", async () => {
    const root = fixtureRoot();
    const outside = mkdtempSync(join(tmpdir(), "steambun-outdir-outside-"));
    writeFileSync(join(outside, "stale.js"), "old");
    const outDir = relative(root, outside);
    writeFileSync(
      join(root, "steambun.config.ts"),
      `export default { build: { outDir: ${JSON.stringify(outDir)}, server: false } };\n`,
    );

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      await build({ root });
    } finally {
      console.warn = originalWarn;
    }

    expect(await Bun.file(join(outside, "stale.js")).exists()).toBe(true);
    expect(warnings.some((w) => w.includes("outside root"))).toBe(true);
  });
});
