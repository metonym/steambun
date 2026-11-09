import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeMetafile,
  checkBudgets,
  compareMetafiles,
  computeCompressedSizes,
  explainImport,
  parseSize,
} from "../src/build/analyze";
import { build } from "../src/build/build";

function fixtureMetafile(): Bun.BuildMetafile {
  return {
    inputs: {
      "src/entry.ts": {
        bytes: 20,
        imports: [{ path: "src/util.ts", kind: "import-statement" }],
      },
      "src/util.ts": {
        bytes: 30,
        imports: [
          { path: "node_modules/left-pad/index.js", kind: "import-statement" },
        ],
      },
      "node_modules/left-pad/index.js": { bytes: 100, imports: [] },
      "node_modules/@scope/pkg/index.js": { bytes: 200, imports: [] },
      "packages/sub/node_modules/left-pad/index.js": {
        bytes: 50,
        imports: [],
      },
    },
    outputs: {
      "./entry.js": {
        bytes: 400,
        inputs: {
          "src/entry.ts": { bytesInOutput: 20 },
          "src/util.ts": { bytesInOutput: 30 },
          "node_modules/left-pad/index.js": { bytesInOutput: 100 },
          "node_modules/@scope/pkg/index.js": { bytesInOutput: 200 },
          "packages/sub/node_modules/left-pad/index.js": {
            bytesInOutput: 50,
          },
        },
        imports: [],
        exports: [],
        entryPoint: "src/entry.ts",
      },
    },
  } as unknown as Bun.BuildMetafile;
}

describe("analyzeMetafile", () => {
  test("groups packages by name, including scoped packages", () => {
    const report = analyzeMetafile(fixtureMetafile());
    const byName = Object.fromEntries(report.packages.map((p) => [p.name, p]));

    expect(byName["left-pad"]?.bytes).toBe(150);
    expect(byName["left-pad"]?.files).toBe(2);
    expect(byName["@scope/pkg"]?.bytes).toBe(200);
    expect(report.total).toBe(400);
  });

  test("nested node_modules directories with different versions are flagged as duplicates", () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-analyze-dup-diff-"));
    mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });
    mkdirSync(join(root, "packages", "sub", "node_modules", "left-pad"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "node_modules", "left-pad", "package.json"),
      JSON.stringify({ name: "left-pad", version: "1.0.0" }),
    );
    writeFileSync(
      join(root, "packages", "sub", "node_modules", "left-pad", "package.json"),
      JSON.stringify({ name: "left-pad", version: "2.0.0" }),
    );
    const prevCwd = process.cwd();
    process.chdir(root);
    try {
      const report = analyzeMetafile(fixtureMetafile());
      const dup = report.duplicates.find((d) => d.name === "left-pad");
      expect(dup).toBeDefined();
      expect(report.duplicates.some((d) => d.name === "@scope/pkg")).toBe(
        false,
      );
    } finally {
      process.chdir(prevCwd);
    }
  });

  test("nested node_modules directories with the same version are not flagged as duplicates", () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-analyze-dup-same-"));
    mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });
    mkdirSync(join(root, "packages", "sub", "node_modules", "left-pad"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "node_modules", "left-pad", "package.json"),
      JSON.stringify({ name: "left-pad", version: "1.0.0" }),
    );
    writeFileSync(
      join(root, "packages", "sub", "node_modules", "left-pad", "package.json"),
      JSON.stringify({ name: "left-pad", version: "1.0.0" }),
    );
    const prevCwd = process.cwd();
    process.chdir(root);
    try {
      const report = analyzeMetafile(fixtureMetafile());
      expect(report.duplicates.some((d) => d.name === "left-pad")).toBe(false);
    } finally {
      process.chdir(prevCwd);
    }
  });

  test("package versions are re-read on every call", () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-analyze-versions-"));
    for (const dir of [
      "node_modules/left-pad",
      "node_modules/@scope/pkg",
      "packages/sub/node_modules/left-pad",
    ]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    const write = (dir: string, version: string) =>
      writeFileSync(
        join(root, dir, "package.json"),
        JSON.stringify({ version }),
      );
    for (const dir of [
      "node_modules/left-pad",
      "node_modules/@scope/pkg",
      "packages/sub/node_modules/left-pad",
    ]) {
      write(dir, "1.0.0");
    }
    const prevCwd = process.cwd();
    process.chdir(root);
    try {
      expect(analyzeMetafile(fixtureMetafile()).packages[0]?.versions).toEqual([
        "1.0.0",
      ]);
      write("node_modules/@scope/pkg", "2.0.0");
      const pkg = analyzeMetafile(fixtureMetafile()).packages.find(
        (p) => p.name === "@scope/pkg",
      );
      expect(pkg?.versions).toEqual(["2.0.0"]);
    } finally {
      process.chdir(prevCwd);
    }
  });

  test("output rows carry per-input byte contributions, largest first", () => {
    const report = analyzeMetafile(fixtureMetafile());
    const output = report.outputs[0];
    expect(output?.path).toBe("entry.js");
    expect(output?.inputs[0]?.bytes).toBeGreaterThanOrEqual(
      output?.inputs[1]?.bytes ?? 0,
    );
  });

  test("resolves a real version from the nearest package.json", () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-analyze-version-"));
    mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(
      join(root, "node_modules", "left-pad", "package.json"),
      JSON.stringify({ name: "left-pad", version: "1.2.3" }),
    );
    const prevCwd = process.cwd();
    process.chdir(root);
    try {
      const report = analyzeMetafile(fixtureMetafile());
      const pkg = report.packages.find((p) => p.name === "left-pad");
      expect(pkg?.versions).toContain("1.2.3");
    } finally {
      process.chdir(prevCwd);
    }
  });
});

describe("explainImport", () => {
  test("returns the shortest chain from an entry to the target", () => {
    const chains = explainImport(fixtureMetafile(), "left-pad");
    expect(chains[0]).toEqual([
      "src/entry.ts",
      "src/util.ts",
      "node_modules/left-pad/index.js",
    ]);
  });

  test("returns no chains when the target is unreachable", () => {
    expect(explainImport(fixtureMetafile(), "nonexistent-pkg")).toEqual([]);
  });
});

describe("parseSize", () => {
  test("parses kb, mb, and bare numbers", () => {
    expect(parseSize("250kb")).toBe(256000);
    expect(parseSize("1.5mb")).toBe(1572864);
    expect(parseSize(1000)).toBe(1000);
    expect(parseSize("1000")).toBe(1000);
  });

  test("rejects malformed sizes instead of yielding NaN", () => {
    for (const bad of ["1.2.3", ".", "kb", "-5kb", "1 gb", ""]) {
      expect(() => parseSize(bad)).toThrow(/Invalid size budget/);
    }
  });
});

describe("checkBudgets", () => {
  test("flags outputs over their glob's limit and ignores ones under it", () => {
    const report = analyzeMetafile(fixtureMetafile());
    const violations = checkBudgets(report.outputs, { "*.js": 100 });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe("entry.js");

    expect(checkBudgets(report.outputs, { "*.js": 1000 })).toHaveLength(0);
  });
});

describe("computeCompressedSizes", () => {
  test("compresses a real file smaller than raw bytes, and skips a missing one", async () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-analyze-compress-"));
    const text = "a".repeat(2000);
    writeFileSync(join(root, "entry.js"), text);
    const outputs = [
      { path: "entry.js", bytes: text.length, inputs: [] },
      { path: "missing.js", bytes: 100, inputs: [] },
    ];

    const sizes = await computeCompressedSizes(outputs, root, {
      brotli: false,
    });

    const entry = sizes.get("entry.js");
    expect(entry).toBeDefined();
    expect(entry!.gzip).toBeLessThan(text.length);
    expect(entry!.zstd).toBeLessThan(text.length);
    expect(entry!.br).toBeUndefined();
    expect(sizes.has("missing.js")).toBe(false);
  });

  test("includes br when brotli is enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-analyze-compress-br-"));
    const text = "b".repeat(2000);
    writeFileSync(join(root, "entry.js"), text);
    const outputs = [{ path: "entry.js", bytes: text.length, inputs: [] }];

    const sizes = await computeCompressedSizes(outputs, root, { brotli: true });

    expect(sizes.get("entry.js")?.br).toBeLessThan(text.length);
  });

  test("reuses a precompressed sibling instead of compressing again", async () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-analyze-sibling-"));
    const text = "c".repeat(2000);
    writeFileSync(join(root, "entry.js"), text);
    // Not a real gzip stream: only its size should be read.
    writeFileSync(join(root, "entry.js.gz"), "x".repeat(7));

    const sizes = await computeCompressedSizes(
      [{ path: "entry.js", bytes: text.length, inputs: [] }],
      root,
      { brotli: false },
    );

    expect(sizes.get("entry.js")?.gzip).toBe(7);
  });
});

describe("compareMetafiles", () => {
  test("reports added, removed, and changed paths, and omits unchanged ones", () => {
    const before = {
      inputs: {},
      outputs: {
        "./same.js": { bytes: 100, inputs: {}, imports: [], exports: [] },
        "./shrunk.js": { bytes: 200, inputs: {}, imports: [], exports: [] },
        "./removed.js": { bytes: 50, inputs: {}, imports: [], exports: [] },
      },
    } as unknown as Bun.BuildMetafile;
    const after = {
      inputs: {},
      outputs: {
        "./same.js": { bytes: 100, inputs: {}, imports: [], exports: [] },
        "./shrunk.js": { bytes: 150, inputs: {}, imports: [], exports: [] },
        "./added.js": { bytes: 30, inputs: {}, imports: [], exports: [] },
      },
    } as unknown as Bun.BuildMetafile;

    const rows = compareMetafiles(before, after);
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));

    expect(byPath["same.js"]).toBeUndefined();
    expect(byPath["added.js"]).toMatchObject({
      status: "added",
      before: 0,
      after: 30,
      delta: 30,
    });
    expect(byPath["removed.js"]).toMatchObject({
      status: "removed",
      before: 50,
      after: 0,
      delta: -50,
    });
    expect(byPath["shrunk.js"]).toMatchObject({
      status: "changed",
      before: 200,
      after: 150,
      delta: -50,
    });
  });
});

describe("build() with build.budgets", () => {
  test("throws and lists the violation when an output exceeds its budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-analyze-build-"));
    writeFileSync(
      join(root, "index.html"),
      `<html><body><script type="module" src="./main.ts"></script></body></html>\n`,
    );
    writeFileSync(
      join(root, "main.ts"),
      `console.log("hello from steambun, this file must exceed the tiny budget below");\n`,
    );
    writeFileSync(
      join(root, "steambun.config.ts"),
      // dist/server.js imports "steambun", unresolvable from this bare fixture.
      `export default { build: { budgets: { "assets/*.js": 1 }, server: false } };\n`,
    );

    await expect(build({ root })).rejects.toThrow(/budget/i);
  });

  test("measures HTML after minification", async () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-analyze-html-"));
    writeFileSync(
      join(root, "index.html"),
      `<!doctype html><html><body><!-- ${"x".repeat(2000)} --><p>hi</p></body></html>\n`,
    );
    writeFileSync(
      join(root, "steambun.config.ts"),
      `export default { build: { budgets: { "*.html": "500b" }, server: false } };\n`,
    );

    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await build({ root });
    } finally {
      log.mockRestore();
    }

    const onDisk = Bun.file(join(root, "dist", "index.html")).size;
    const metafile = JSON.parse(
      await Bun.file(join(root, ".steambun", "metafile.json")).text(),
    );
    expect(metafile.outputs["./index.html"].bytes).toBe(onDisk);
    expect(onDisk).toBeLessThan(500);
  });
});
