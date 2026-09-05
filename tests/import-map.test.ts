import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../src/build/build";
import {
  injectImportMap,
  rewriteChunkSource,
  stableChunkIds,
} from "../src/build/import-map";
import { createStaticHandler } from "../src/runtime/static";

function fakeMetafile(
  outputs: Record<string, { inputs: string[] }>,
): Bun.BuildMetafile {
  const built: Record<string, unknown> = {};
  for (const [path, o] of Object.entries(outputs)) {
    const inputs: Record<string, { bytesInOutput: number }> = {};
    for (const input of o.inputs) inputs[input] = { bytesInOutput: 1 };
    built[path] = { bytes: 10, inputs, imports: [], exports: [] };
  }
  return { inputs: {}, outputs: built } as unknown as Bun.BuildMetafile;
}

describe("stableChunkIds", () => {
  test("same inputs in a different order produce the same id", () => {
    const a = fakeMetafile({
      "./assets/x-aaa.js": { inputs: ["src/a.ts", "src/b.ts"] },
    });
    const b = fakeMetafile({
      "./assets/x-bbb.js": { inputs: ["src/b.ts", "src/a.ts"] },
    });
    expect(stableChunkIds(a).get("assets/x-aaa.js")).toBe(
      stableChunkIds(b).get("assets/x-bbb.js"),
    );
  });

  test("different inputs produce different ids", () => {
    const a = fakeMetafile({ "./assets/x-aaa.js": { inputs: ["src/a.ts"] } });
    const b = fakeMetafile({ "./assets/x-bbb.js": { inputs: ["src/c.ts"] } });
    expect(stableChunkIds(a).get("assets/x-aaa.js")).not.toBe(
      stableChunkIds(b).get("assets/x-bbb.js"),
    );
  });
});

describe("rewriteChunkSource", () => {
  test("rewrites a relative specifier that resolves to a known output", () => {
    const stable = new Map([["assets/vendor-aaa.js", "id1"]]);
    const src = 'import{x}from"./vendor-aaa.js";console.log(x);';
    const out = rewriteChunkSource(src, {
      rel: "assets/index-bbb.js",
      outDir: "/tmp/dist",
      base: "/",
      stable,
      tokens: new Map(),
    });
    expect(out).toBe('import{x}from"/@chunk/id1.js";console.log(x);');
  });

  test("resolves a ../ specifier from a nested chunk", () => {
    const stable = new Map([["assets/vendor-aaa.js", "id1"]]);
    const src = 'import{x}from"../vendor-aaa.js";';
    const out = rewriteChunkSource(src, {
      rel: "assets/nested/page-bbb.js",
      outDir: "/tmp/dist",
      base: "/",
      stable,
      tokens: new Map(),
    });
    expect(out).toBe('import{x}from"/@chunk/id1.js";');
  });

  test("rewrites a base-absolute specifier", () => {
    const stable = new Map([["assets/vendor-aaa.js", "id1"]]);
    const src = 'import{x}from"/app/assets/vendor-aaa.js";';
    const out = rewriteChunkSource(src, {
      rel: "assets/index-bbb.js",
      outDir: "/tmp/dist",
      base: "/app/",
      stable,
      tokens: new Map(),
    });
    expect(out).toBe('import{x}from"/app/@chunk/id1.js";');
  });

  test("leaves an unresolvable relative specifier untouched", () => {
    const src = 'import{x}from"./not-a-chunk.js";';
    const out = rewriteChunkSource(src, {
      rel: "assets/index-bbb.js",
      outDir: "/tmp/dist",
      base: "/",
      stable: new Map(),
      tokens: new Map(),
    });
    expect(out).toBe(src);
  });

  test("rewrites helper hash tokens only in the anchored region and call sites", () => {
    const tokens = new Map([
      ["tok1", "id1"],
      ["tok2", "id2"],
    ]);
    const src =
      'g(import.meta.url,["tok1","tok2"],[["./a-tok1.js",2],["./b-tok2.js"]],0);\n' +
      'z("tok1");\n' +
      'const unrelated = "tok1notreally";\n';
    const out = rewriteChunkSource(src, {
      rel: "assets/index.js",
      outDir: "/tmp/dist",
      base: "/",
      stable: new Map(),
      tokens,
    });
    expect(out).toContain('["id1","id2"]');
    expect(out).toContain('z("id1")');
    expect(out).toContain('"tok1notreally"');
  });

  test("an unrelated 8-char literal outside the anchor and any call is untouched", () => {
    const tokens = new Map([["tok12345", "id9"]]);
    const src = 'const x = "tok12345"; console.log(x);';
    const out = rewriteChunkSource(src, {
      rel: "assets/index.js",
      outDir: "/tmp/dist",
      base: "/",
      stable: new Map(),
      tokens,
    });
    expect(out).toBe(src);
  });

  test("a chunk with no helper and no rewritable imports is byte-identical", () => {
    const src = "export const x = 1;";
    const out = rewriteChunkSource(src, {
      rel: "assets/plain-aaa.js",
      outDir: "/tmp/dist",
      base: "/",
      stable: new Map(),
      tokens: new Map(),
    });
    expect(out).toBe(src);
  });
});

describe("injectImportMap", () => {
  test("the map is the first child of <head>", async () => {
    const html =
      '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';
    const out = await injectImportMap(html, {
      imports: { "/@chunk/id1.js": "/assets/vendor-xxx.js" },
      renames: new Map(),
      htmlDirRel: "",
      base: "/",
    });
    expect(out).toContain('<head><script type="importmap">');
  });

  test("a page with no <head> gets the map before the first <script>", async () => {
    const html =
      '<!doctype html><html><body><script src="./a.js"></script></body></html>';
    const out = await injectImportMap(html, {
      imports: { "/@chunk/id1.js": "/assets/a.js" },
      renames: new Map(),
      htmlDirRel: "",
      base: "/",
    });
    const mapIdx = out.indexOf('type="importmap"');
    const scriptIdx = out.indexOf("<script src=");
    expect(mapIdx).toBeGreaterThan(-1);
    expect(mapIdx).toBeLessThan(scriptIdx);
  });

  test("updates src/href for renamed files, leaves others untouched", async () => {
    const html =
      "<!doctype html><html><head></head><body>" +
      '<script type="module" src="./assets/index-old.js"></script>' +
      '<link rel="modulepreload" href="./assets/vendor-old.js">' +
      '<link rel="stylesheet" href="./assets/other.css">' +
      "</body></html>";
    const renames = new Map([
      ["assets/index-old.js", "assets/index-new.js"],
      ["assets/vendor-old.js", "assets/vendor-new.js"],
    ]);
    const out = await injectImportMap(html, {
      imports: {},
      renames,
      htmlDirRel: "",
      base: "/",
    });
    expect(out).toContain('src="./assets/index-new.js"');
    expect(out).toContain('href="./assets/vendor-new.js"');
    expect(out).toContain('href="./assets/other.css"');
  });

  test("merges into an existing import map instead of duplicating", async () => {
    const html =
      '<!doctype html><html><head><script type="importmap">{"imports":{"foo":"/bar.js"}}</script></head><body></body></html>';
    const out = await injectImportMap(html, {
      imports: { foo: "/overridden.js", baz: "/qux.js" },
      renames: new Map(),
      htmlDirRel: "",
      base: "/",
    });
    expect(out.match(/type="importmap"/g)).toHaveLength(1);
    const jsonText = out.match(
      /<script type="importmap">([\s\S]*?)<\/script>/,
    )?.[1];
    const parsed = JSON.parse(jsonText ?? "{}");
    expect(parsed.imports.foo).toBe("/overridden.js");
    expect(parsed.imports.baz).toBe("/qux.js");
  });
});

function writeCascadeFixture(dir: string): void {
  mkdirSync(join(dir, "src"));
  for (const page of ["index", "about", "blog"]) {
    writeFileSync(
      join(dir, `${page}.html`),
      `<!doctype html><html><head></head><body><script type="module" src="./src/${page}.ts"></script></body></html>\n`,
    );
  }
  writeFileSync(
    join(dir, "src/vendor.ts"),
    `export const vendor = "V".repeat(3000);\n`,
  );
  writeFileSync(
    join(dir, "src/ab.ts"),
    `export const ab = "AB".repeat(500);\n`,
  );
  writeFileSync(
    join(dir, "src/bc.ts"),
    `export const bc = "BC".repeat(500);\n`,
  );
  writeFileSync(join(dir, "src/tiny.ts"), `export const tiny = "t";\n`);
  writeFileSync(
    join(dir, "src/lazy.ts"),
    `import { vendor } from "./vendor";\nexport const lazy = vendor + "lazy";\n`,
  );
  writeFileSync(
    join(dir, "src/index.ts"),
    `import { vendor } from "./vendor";
import { ab } from "./ab";
import { tiny } from "./tiny";
document.body.dataset.result = JSON.stringify({ vendor: vendor.length, ab, tiny });
if (location.search.includes("go")) import("./lazy");
`,
  );
  writeFileSync(
    join(dir, "src/about.ts"),
    `import { vendor } from "./vendor";
import { ab } from "./ab";
import { bc } from "./bc";
import { tiny } from "./tiny";
document.body.dataset.result = JSON.stringify({ vendor: vendor.length, ab, bc, tiny });
`,
  );
  writeFileSync(
    join(dir, "src/blog.ts"),
    `import { vendor } from "./vendor";
import { bc } from "./bc";
document.body.dataset.result = JSON.stringify({ vendor: vendor.length, bc });
`,
  );
  writeFileSync(
    join(dir, "steambun.config.ts"),
    `export default { build: { splitting: true, importMap: true, server: false } };\n`,
  );
}

async function chunkFileSet(dir: string): Promise<Set<string>> {
  const chunkMap = JSON.parse(
    await Bun.file(join(dir, "dist", ".steambun-chunks.json")).text(),
  ) as Record<string, string>;
  return new Set(Object.values(chunkMap));
}

describe("import map cascade (integration)", () => {
  test("changing a shared module renames only its own chunk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-importmap-"));
    writeCascadeFixture(dir);

    await build({ root: dir });
    const before = await chunkFileSet(dir);

    writeFileSync(
      join(dir, "src/vendor.ts"),
      `export const vendor = "V".repeat(3000) + "X";\n`,
    );
    await build({ root: dir });
    const after = await chunkFileSet(dir);

    const added = [...after].filter((f) => !before.has(f));
    const removed = [...before].filter((f) => !after.has(f));
    expect(added).toHaveLength(1);
    expect(removed).toHaveLength(1);
  });

  test("changing a single-page module renames only that page's chunk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-importmap-"));
    writeCascadeFixture(dir);

    await build({ root: dir });
    const before = await chunkFileSet(dir);

    writeFileSync(
      join(dir, "src/blog.ts"),
      `import { vendor } from "./vendor";
import { bc } from "./bc";
document.body.dataset.result = JSON.stringify({ vendor: vendor.length, bc, changed: true });
`,
    );
    await build({ root: dir });
    const after = await chunkFileSet(dir);

    const added = [...after].filter((f) => !before.has(f));
    const removed = [...before].filter((f) => !after.has(f));
    expect(added).toHaveLength(1);
    expect(removed).toHaveLength(1);
  });

  test("every page has one import map and .steambun-chunks.json maps every id to an existing file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-importmap-"));
    writeCascadeFixture(dir);
    await build({ root: dir });

    for (const page of ["index", "about", "blog"]) {
      const html = await Bun.file(join(dir, "dist", `${page}.html`)).text();
      expect(html.match(/type="importmap"/g)).toHaveLength(1);
    }

    const chunkMap = JSON.parse(
      await Bun.file(join(dir, "dist", ".steambun-chunks.json")).text(),
    ) as Record<string, string>;
    expect(Object.keys(chunkMap).length).toBeGreaterThan(0);
    for (const rel of Object.values(chunkMap)) {
      expect(await Bun.file(join(dir, "dist", rel)).exists()).toBe(true);
    }
  });

  test(".steambun/metafile.json and manifest.json reflect renamed files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-importmap-"));
    writeCascadeFixture(dir);
    writeFileSync(
      join(dir, "steambun.config.ts"),
      `export default { build: { splitting: true, importMap: true, manifest: true, server: false } };\n`,
    );
    await build({ root: dir });

    const metafile = JSON.parse(
      await Bun.file(join(dir, ".steambun/metafile.json")).text(),
    ) as { outputs: Record<string, unknown> };
    for (const outputPath of Object.keys(metafile.outputs)) {
      const rel = outputPath.replace(/^\.\//, "");
      expect(await Bun.file(join(dir, "dist", rel)).exists()).toBe(true);
    }

    const manifest = JSON.parse(
      await Bun.file(join(dir, "dist/manifest.json")).text(),
    ) as Record<string, { file: string }>;
    for (const chunk of Object.values(manifest)) {
      expect(await Bun.file(join(dir, "dist", chunk.file)).exists()).toBe(true);
    }
  });
});

describe("createStaticHandler — import-map chunk redirect", () => {
  test("/@chunk/<id>.js redirects to the current hashed file", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "steambun-chunkmap-"));
    writeFileSync(
      join(outDir, ".steambun-chunks.json"),
      JSON.stringify({ abc123: "assets/vendor-xyz.js" }),
    );
    const handler = createStaticHandler({
      outDir,
      spa: false,
      chunkMapFile: join(outDir, ".steambun-chunks.json"),
    });

    const res = await handler(new Request("http://localhost/@chunk/abc123.js"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/assets/vendor-xyz.js");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("an unknown chunk id is 404", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "steambun-chunkmap-"));
    writeFileSync(join(outDir, ".steambun-chunks.json"), JSON.stringify({}));
    const handler = createStaticHandler({
      outDir,
      spa: false,
      chunkMapFile: join(outDir, ".steambun-chunks.json"),
    });
    const res = await handler(new Request("http://localhost/@chunk/nope.js"));
    expect(res.status).toBe(404);
  });

  test("with base '/app/' the chunk key is under that prefix", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "steambun-chunkmap-"));
    writeFileSync(
      join(outDir, ".steambun-chunks.json"),
      JSON.stringify({ abc123: "assets/vendor-xyz.js" }),
    );
    const handler = createStaticHandler({
      outDir,
      spa: false,
      chunkMapFile: join(outDir, ".steambun-chunks.json"),
      base: "/app/",
    });
    const res = await handler(
      new Request("http://localhost/app/@chunk/abc123.js"),
    );
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/app/assets/vendor-xyz.js");
  });
});

describe("import map + sourcemaps", () => {
  test("sourcemap siblings are renamed along with their .js", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-importmap-map-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "index.html"),
      `<!doctype html><html><head></head><body><script type="module" src="./src/index.ts"></script></body></html>\n`,
    );
    writeFileSync(
      join(dir, "about.html"),
      `<!doctype html><html><head></head><body><script type="module" src="./src/about.ts"></script></body></html>\n`,
    );
    writeFileSync(
      join(dir, "src/vendor.ts"),
      `export const v = "v".repeat(2000);\n`,
    );
    writeFileSync(
      join(dir, "src/index.ts"),
      `import { v } from "./vendor";\nconsole.log(v);\n`,
    );
    writeFileSync(
      join(dir, "src/about.ts"),
      `import { v } from "./vendor";\nconsole.log(v, "about");\n`,
    );
    writeFileSync(
      join(dir, "steambun.config.ts"),
      `export default { build: { splitting: true, importMap: true, sourcemap: "external", server: false } };\n`,
    );

    await build({ root: dir });
    const assetsDir = join(dir, "dist", "assets");
    const files = readdirSync(assetsDir);
    const jsFiles = files.filter((f) => f.endsWith(".js"));
    expect(jsFiles.length).toBeGreaterThan(0);
    for (const js of jsFiles) {
      expect(files).toContain(`${js}.map`);
    }
  });
});
