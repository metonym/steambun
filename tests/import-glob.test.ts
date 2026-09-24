import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createImportGlobPlugin,
  transformImportGlobs,
} from "../src/util/import-glob";

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "steambun-glob-"));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

function transform(root: string, source: string, importer = "src/main.ts") {
  return transformImportGlobs(source, {
    importer: join(root, importer),
    root,
    alias: { "@": "./src" },
  });
}

const MODS = {
  "src/mods/a.ts": "export default 'a'; export const name = 'A';",
  "src/mods/b.ts": "export default 'b'; export const name = 'B';",
  "src/mods/c.txt": "c",
};

describe("transformImportGlobs", () => {
  test("returns undefined without a call", () => {
    const root = project(MODS);
    expect(transform(root, "const x = 1;")).toBeUndefined();
    expect(
      transform(
        root,
        '// import.meta.glob("./mods/*.ts")\nconst s = "import.meta.glob";',
      ),
    ).toBeUndefined();
  });

  test("lazy by default, keyed by importer-relative path, sorted", () => {
    const root = project(MODS);
    expect(transform(root, 'const m = import.meta.glob("./mods/*.ts");')).toBe(
      'const m = ({"./mods/a.ts": () => import("./mods/a.ts"), "./mods/b.ts": () => import("./mods/b.ts")});',
    );
  });

  test("eager appends hoisted imports and keeps the line count", () => {
    const root = project(MODS);
    const out = transform(
      root,
      'const m = import.meta.glob(\n  "./mods/*.ts",\n  { eager: true, import: "default" },\n);\nexport { m };',
    );
    expect(out).toBe(
      'const m = ({"./mods/a.ts": __steambun_glob_0_0, "./mods/b.ts": __steambun_glob_0_1})\n\n\n;\nexport { m };\n' +
        'import { default as __steambun_glob_0_0 } from "./mods/a.ts";\n' +
        'import { default as __steambun_glob_0_1 } from "./mods/b.ts";\n',
    );
  });

  test("lazy named import, query, negatives, arrays, and type arguments", () => {
    const root = project(MODS);
    expect(
      transform(
        root,
        'import.meta.glob<string>(["./mods/*", "!./mods/b.ts", "!**/*.txt"], { import: "name", query: "?x=1" })',
      ),
    ).toBe(
      '({"./mods/a.ts": () => import("./mods/a.ts?x=1").then((m) => m["name"])})',
    );
    expect(
      transform(
        root,
        'import.meta.glob("./mods/*.txt", { query: { raw: true } })',
      ),
    ).toBe('({"./mods/c.txt": () => import("./mods/c.txt?raw=true")})');
  });

  test("root-relative and aliased patterns are keyed from root", () => {
    const root = project(MODS);
    const expected =
      '({"/src/mods/a.ts": () => import("../mods/a.ts"), "/src/mods/b.ts": () => import("../mods/b.ts")})';
    expect(
      transform(root, 'import.meta.glob("/src/mods/*.ts")', "src/pages/x.ts"),
    ).toBe(expected);
    expect(
      transform(root, 'import.meta.glob("@/mods/*.ts")', "src/pages/x.ts"),
    ).toBe(expected);
  });

  test("excludes the importer and node_modules unless exhaustive", () => {
    const root = project({
      "src/a.ts": "",
      "src/node_modules/dep/index.ts": "",
      "src/.hidden.ts": "",
    });
    expect(transform(root, 'import.meta.glob("./**/*.ts")', "src/a.ts")).toBe(
      "({})",
    );
    expect(
      transform(
        root,
        'import.meta.glob("./**/*.ts", { exhaustive: true })',
        "src/a.ts",
      ),
    ).toBe(
      '({"./.hidden.ts": () => import("./.hidden.ts"), "./node_modules/dep/index.ts": () => import("./node_modules/dep/index.ts")})',
    );
  });

  test("finds calls inside template interpolations only", () => {
    const root = project(MODS);
    const out = transform(
      root,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
      'const t = `import.meta.glob ${Object.keys(import.meta.glob("./mods/a.ts"))}`;',
    );
    expect(out).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: expected source text
      'const t = `import.meta.glob ${Object.keys(({"./mods/a.ts": () => import("./mods/a.ts")}))}`;',
    );
  });

  test("rejects non-literal arguments and unsupported options", () => {
    const root = project(MODS);
    expect(() => transform(root, "import.meta.glob(dir)")).toThrow(
      /must be literals/,
    );
    expect(() =>
      transform(root, 'import.meta.glob("./mods/*", { as: "raw" })'),
    ).toThrow(/`as` was removed/);
    expect(() => transform(root, 'import.meta.glob("mods/*")')).toThrow(
      /must start with/,
    );
  });
});

describe("createImportGlobPlugin", () => {
  test("Bun.build bundles eager and lazy globs", async () => {
    const root = project({
      ...MODS,
      "src/main.ts":
        'const eager = import.meta.glob("./mods/*.ts", { eager: true, import: "default" });\n' +
        'const lazy = import.meta.glob("./mods/*.ts");\n' +
        "const loaded = await lazy['./mods/b.ts']!();\n" +
        "console.log(JSON.stringify([eager, Object.keys(lazy), loaded.name]));\n",
    });
    const result = await Bun.build({
      entrypoints: [join(root, "src/main.ts")],
      outdir: join(root, "dist"),
      target: "bun",
      plugins: [createImportGlobPlugin(root)],
    });
    expect(result.success).toBe(true);
    const proc = Bun.spawnSync(["bun", join(root, "dist/main.js")]);
    expect(JSON.parse(proc.stdout.toString())).toEqual([
      { "./mods/a.ts": "a", "./mods/b.ts": "b" },
      ["./mods/a.ts", "./mods/b.ts"],
      "B",
    ]);
  });
});
