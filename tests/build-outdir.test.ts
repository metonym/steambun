import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
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
    const warn = spyOn(console, "warn").mockImplementation((msg) => {
      warnings.push(String(msg));
    });
    try {
      await build({ root });
    } finally {
      warn.mockRestore();
    }

    expect(await Bun.file(join(outside, "stale.js")).exists()).toBe(true);
    expect(warnings.some((w) => w.includes("outside root"))).toBe(true);
  });
});

describe("build() publicDir", () => {
  test("built HTML wins over a same-named public file; other public files are copied", async () => {
    const root = fixtureRoot();
    mkdirSync(join(root, "public"), { recursive: true });
    writeFileSync(join(root, "public", "index.html"), "PUBLIC");
    writeFileSync(join(root, "public", "robots.txt"), "ok");
    writeFileSync(
      join(root, "steambun.config.ts"),
      `export default { publicDir: "public", build: { server: false } };\n`,
    );

    await build({ root });

    expect(await Bun.file(join(root, "dist", "robots.txt")).text()).toBe("ok");
    expect(await Bun.file(join(root, "dist", "index.html")).text()).not.toBe(
      "PUBLIC",
    );
  });

  test("dotfiles and dot-directories in publicDir are not published", async () => {
    const root = fixtureRoot();
    mkdirSync(join(root, "public", ".secrets"), { recursive: true });
    mkdirSync(join(root, "public", "img"), { recursive: true });
    writeFileSync(join(root, "public", ".env"), "TOKEN=1");
    writeFileSync(join(root, "public", ".env.local"), "TOKEN=1");
    writeFileSync(join(root, "public", ".DS_Store"), "junk");
    writeFileSync(join(root, "public", ".secrets", "key.txt"), "k");
    writeFileSync(join(root, "public", "img", ".gitkeep"), "");
    writeFileSync(join(root, "public", "img", "a.txt"), "a");
    writeFileSync(
      join(root, "steambun.config.ts"),
      `export default { publicDir: "public", build: { server: false } };\n`,
    );

    await build({ root });

    expect(readdirSync(join(root, "dist"), { recursive: true }).sort()).toEqual(
      expect.arrayContaining(["img", join("img", "a.txt")]),
    );
    const published = readdirSync(join(root, "dist"), { recursive: true })
      .map(String)
      .filter((path) => path.split(sep).some((part) => part.startsWith(".")));
    expect(published).toEqual([]);
  });

  test("a publicDir under a dot-directory path is still copied", async () => {
    const root = fixtureRoot();
    const publicDir = join(root, ".static", "files");
    mkdirSync(publicDir, { recursive: true });
    writeFileSync(join(publicDir, "robots.txt"), "ok");
    writeFileSync(
      join(root, "steambun.config.ts"),
      `export default { publicDir: ".static/files", build: { server: false } };\n`,
    );

    await build({ root });

    expect(await Bun.file(join(root, "dist", "robots.txt")).text()).toBe("ok");
  });
});

describe("build() failures", () => {
  test("a missing script is reported with the unresolved path", async () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-missing-"));
    writeFileSync(
      join(root, "index.html"),
      `<html><script type="module" src="./missing.ts"></script></html>\n`,
    );
    writeFileSync(
      join(root, "steambun.config.ts"),
      `export default { build: { server: false } };\n`,
    );
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(build({ root })).rejects.toThrow("Build failed");
      expect(error.mock.calls.flat().join("\n")).toContain("missing.ts");
    } finally {
      error.mockRestore();
    }
  });
});
