import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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

  test("excludes the importer, dotfiles, and node_modules below the pattern's directory", () => {
    const root = project({
      "src/a.ts": "",
      "src/node_modules/dep/index.ts": "",
      "src/.hidden.ts": "",
      "src/my_node_modules_docs/y.ts": "",
    });
    expect(transform(root, 'import.meta.glob("./**/*.ts")', "src/a.ts")).toBe(
      '({"./my_node_modules_docs/y.ts": () => import("./my_node_modules_docs/y.ts")})',
    );
    expect(transform(root, 'import.meta.glob("./node_modules/dep/*.ts")')).toBe(
      '({"./node_modules/dep/index.ts": () => import("./node_modules/dep/index.ts")})',
    );
  });

  test("globs under directories whose names contain glob characters", () => {
    const root = project({ "src/[id]/a.ts": "", "src/[id]/b.ts": "" });
    expect(transform(root, 'import.meta.glob("./*.ts")', "src/[id]/b.ts")).toBe(
      '({"./a.ts": () => import("./a.ts")})',
    );
  });

  test("extglob and brace-range segments are globs, a bare (group) is literal", () => {
    const root = project({
      "src/app/a.ts": "",
      "src/lib/b.ts": "",
      "src/internal/c.ts": "",
      "src/(group)/d.ts": "",
      "src/shard-1.json": "",
      "src/shard-2.json": "",
      "src/shard-5.json": "",
    });
    expect(
      transform(root, 'import.meta.glob("./!(internal|*group*)/*.ts")'),
    ).toBe(
      '({"./app/a.ts": () => import("./app/a.ts"), "./lib/b.ts": () => import("./lib/b.ts")})',
    );
    expect(transform(root, 'import.meta.glob("./@(lib)/*.ts")')).toBe(
      '({"./lib/b.ts": () => import("./lib/b.ts")})',
    );
    expect(transform(root, 'import.meta.glob("./(group)/*.ts")')).toBe(
      '({"./(group)/d.ts": () => import("./(group)/d.ts")})',
    );
    expect(transform(root, 'import.meta.glob("./shard-{1..3}.json")')).toBe(
      '({"./shard-1.json": () => import("./shard-1.json"), "./shard-2.json": () => import("./shard-2.json")})',
    );
  });

  test("a literal pattern matches files, not directories", () => {
    const root = project(MODS);
    expect(transform(root, 'import.meta.glob("./mods")')).toBe("({})");
    expect(transform(root, 'import.meta.glob("./mods/a.ts")')).toBe(
      '({"./mods/a.ts": () => import("./mods/a.ts")})',
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
      transform(root, 'import.meta.glob("./mods/*", { nope: true })'),
    ).toThrow(/unsupported option "nope" \(supported: eager, import, query\)/);
    for (const option of ["exhaustive", "base", "as", "caseSensitive"]) {
      expect(() =>
        transform(root, `import.meta.glob("./mods/*", { ${option}: true })`),
      ).toThrow(`unsupported option "${option}"`);
    }
    expect(() => transform(root, 'import.meta.glob("mods/*")')).toThrow(
      /must start with/,
    );
  });
});

describe("matching", () => {
  test("follows symlinked directories like fast-glob", () => {
    if (process.platform === "win32") return;
    const root = project({ "src/real/a.ts": "", "src/main.ts": "" });
    symlinkSync(join(root, "src/real"), join(root, "src/link"));
    expect(transform(root, 'import.meta.glob("./**/a.ts")')).toBe(
      '({"./link/a.ts": () => import("./link/a.ts"), "./real/a.ts": () => import("./real/a.ts")})',
    );
  });

  test("a pattern that is exactly an alias key resolves like Vite: a file matches, a directory is empty", () => {
    const root = project({ ...MODS, "src/mods/a.ts": "" });
    const ctx = (alias: Record<string, string>) => ({
      importer: join(root, "src/main.ts"),
      root,
      alias,
    });
    expect(
      transformImportGlobs(
        'import.meta.glob("@mod")',
        ctx({ "@mod": "./src/mods/a.ts" }),
      ),
    ).toBe('({"/src/mods/a.ts": () => import("./mods/a.ts")})');
    expect(
      transformImportGlobs('import.meta.glob("@")', ctx({ "@": "./src" })),
    ).toBe("({})");
    expect(() =>
      transformImportGlobs('import.meta.glob("@x")', ctx({ "@": "./src" })),
    ).toThrow(/must start with/);
  });
});

describe("string literals", () => {
  const glob = (root: string, arg: string) =>
    transform(root, `import.meta.glob(${arg})`);

  test("\\u and \\x escapes are code units", () => {
    const root = project({ "src/mods/ab.ts": "" });
    expect(glob(root, String.raw`'./mods/\u0061\x62.ts'`)).toBe(
      '({"./mods/ab.ts": () => import("./mods/ab.ts")})',
    );
    expect(glob(root, String.raw`'./mods/\u{61}b.ts'`)).toBe(
      '({"./mods/ab.ts": () => import("./mods/ab.ts")})',
    );
  });

  test("an escaped quote is the quote, and a line continuation vanishes", () => {
    const root = project({ "src/mods/q'x.ts": "", "src/mods/ab.ts": "" });
    expect(glob(root, String.raw`'./mods/q\'x.ts'`)).toBe(
      `({"./mods/q'x.ts": () => import("./mods/q'x.ts")})`,
    );
    expect(glob(root, "'./mods/a\\\nb.ts'")).toBe(
      '({"./mods/ab.ts": () => import("./mods/ab.ts")})\n',
    );
  });

  test("\\n is a newline, not the letter n", () => {
    const root = project({ "src/mods/anb.ts": "" });
    expect(glob(root, String.raw`"./mods/a\nb.ts"`)).toBe("({})");
    expect(glob(root, String.raw`"./mods/a\u006eb.ts"`)).toBe(
      '({"./mods/anb.ts": () => import("./mods/anb.ts")})',
    );
  });

  test("a newline escape matches a file whose name has a newline", () => {
    if (process.platform === "win32") return;
    const root = project({ "src/mods/a\nb.ts": "" });
    expect(glob(root, String.raw`"./mods/a\nb.ts"`)).toBe(
      '({"./mods/a\\nb.ts": () => import("./mods/a\\nb.ts")})',
    );
  });

  test("a backslash escape (\\\\) is one backslash", () => {
    if (process.platform === "win32") return;
    const root = project({ "src/mods/a\\b.ts": "" });
    expect(glob(root, String.raw`"./mods/a\\b.ts"`)).toBe(
      '({"./mods/a\\\\b.ts": () => import("./mods/a\\\\b.ts")})',
    );
  });
});

describe("call-site scanner", () => {
  test("a regex literal with an unbalanced quote does not hide a later call", () => {
    const root = project(MODS);
    for (const prelude of [
      'const q = /"/;',
      "const q = /'/g;",
      "const q = /[\"']/;",
      "const q = a.replace(/`/g, '');",
      'if (x) { y = /"/.test(z); }',
      "const f = (s) => /'/.test(s);",
      "return /'/.test(s) && ",
    ]) {
      const out = transform(
        root,
        `${prelude}\nconst m = import.meta.glob("./mods/a.ts");`,
      );
      expect(out).toContain("() => import(");
    }
  });

  test("division and JSX closing tags are not mistaken for regexes", () => {
    const root = project(MODS);
    expect(
      transform(
        root,
        'const h = a / b / c; const m = import.meta.glob("./mods/a.ts");',
      ),
    ).toContain("() => import(");
    expect(
      transform(
        root,
        'const el = <b>x</b>; const m = import.meta.glob("./mods/a.ts");',
      ),
    ).toContain("() => import(");
  });

  test("an unterminated quote in JSX text only hides the rest of its line", () => {
    const root = project(MODS);
    expect(
      transform(
        root,
        "const el = <p>don't</p>;\nconst m = import.meta.glob('./mods/a.ts');",
      ),
    ).toContain("() => import(");
  });

  test("a call text inside a regex is not expanded", () => {
    const root = project(MODS);
    expect(
      transform(root, 'const r = /import.meta.glob("x")/;'),
    ).toBeUndefined();
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
