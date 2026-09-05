import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeMetafile,
  checkBudgets,
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

  test("nested node_modules directories are flagged as duplicates", () => {
    const report = analyzeMetafile(fixtureMetafile());
    const dup = report.duplicates.find((d) => d.name === "left-pad");
    expect(dup).toBeDefined();
    expect(report.duplicates.some((d) => d.name === "@scope/pkg")).toBe(false);
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
      // build.server would try to bundle a dist server that statically
      // imports "steambun", unresolvable from this bare fixture (no
      // node_modules) — irrelevant to what this test checks.
      `export default { build: { budgets: { "assets/*.js": 1 }, server: false } };\n`,
    );

    await expect(build({ root })).rejects.toThrow(/budget/i);
  });
});
