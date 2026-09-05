import { describe, expect, test } from "bun:test";
import {
  mergeRenames,
  renameArtifacts,
  renameMetafileOutputs,
} from "../src/build/rename";

describe("mergeRenames", () => {
  test("chains a rename through a second rename map", () => {
    const a = new Map([["assets/vendor-aaa.js", "assets/vendor-bbb.js"]]);
    const b = new Map([["assets/vendor-bbb.js", "assets/vendor-ccc.js"]]);
    const merged = mergeRenames(a, b);
    expect(merged.get("assets/vendor-aaa.js")).toBe("assets/vendor-ccc.js");
    expect(merged.size).toBe(1);
  });

  test("keeps a's rename when b doesn't touch its result", () => {
    const a = new Map([["assets/vendor-aaa.js", "assets/vendor-bbb.js"]]);
    const b = new Map([["assets/page-xxx.css", "assets/page-yyy.css"]]);
    const merged = mergeRenames(a, b);
    expect(merged.get("assets/vendor-aaa.js")).toBe("assets/vendor-bbb.js");
    expect(merged.get("assets/page-xxx.css")).toBe("assets/page-yyy.css");
    expect(merged.size).toBe(2);
  });

  test("empty maps compose to an empty map", () => {
    expect(mergeRenames(new Map(), new Map()).size).toBe(0);
  });
});

function metafileFixture(): Bun.BuildMetafile {
  return {
    inputs: {},
    outputs: {
      "./assets/index-aaa.js": {
        bytes: 10,
        inputs: {},
        imports: [{ path: "./assets/vendor-old.js", kind: "import-statement" }],
        exports: [],
        entryPoint: "index.html",
        cssBundle: "./assets/index-css1.css",
      },
      "./assets/vendor-old.js": {
        bytes: 20,
        inputs: {},
        imports: [],
        exports: [],
      },
      "./index.html": {
        bytes: 5,
        inputs: {},
        imports: [],
        exports: [],
        entryPoint: "index.html",
      },
    },
  } as unknown as Bun.BuildMetafile;
}

describe("renameMetafileOutputs", () => {
  test("rewrites keys, cssBundle, and import paths", () => {
    const renames = new Map([
      ["assets/vendor-old.js", "assets/vendor-new.js"],
      ["assets/index-css1.css", "assets/index-css2.css"],
    ]);
    const renamed = renameMetafileOutputs(metafileFixture(), renames);

    expect(renamed.outputs["./assets/vendor-new.js"]).toBeDefined();
    expect(renamed.outputs["./assets/vendor-old.js"]).toBeUndefined();

    const entry = renamed.outputs["./assets/index-aaa.js"]!;
    expect(entry.cssBundle).toBe("./assets/index-css2.css");
    expect(entry.imports).toEqual([
      { path: "./assets/vendor-new.js", kind: "import-statement" },
    ]);
  });

  test("leaves untouched entries identical", () => {
    const renames = new Map([["assets/vendor-old.js", "assets/vendor-new.js"]]);
    const original = metafileFixture();
    const renamed = renameMetafileOutputs(original, renames);
    expect(renamed.outputs["./index.html"]).toBe(
      original.outputs["./index.html"],
    );
  });

  test("empty rename map returns the same metafile reference", () => {
    const original = metafileFixture();
    expect(renameMetafileOutputs(original, new Map())).toBe(original);
  });
});

describe("renameArtifacts", () => {
  test("maps only renamed paths, by outDir-relative path", () => {
    const outDir = "/tmp/dist";
    const outputs = [
      { kind: "chunk", path: "/tmp/dist/assets/vendor-old.js" },
      { kind: "entry-point", path: "/tmp/dist/index.html" },
    ] as unknown as Bun.BuildArtifact[];
    const renames = new Map([["assets/vendor-old.js", "assets/vendor-new.js"]]);

    const result = renameArtifacts(outputs, renames, outDir);
    expect(result).toEqual([
      { kind: "chunk", path: "/tmp/dist/assets/vendor-new.js" },
      { kind: "entry-point", path: "/tmp/dist/index.html" },
    ]);
  });
});
