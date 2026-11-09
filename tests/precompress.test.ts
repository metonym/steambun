import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { build } from "../src/build/build";
import {
  compressedSize,
  precompressDir,
  precompressedSize,
} from "../src/build/precompress";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "steambun-precompress-"));
}

describe("precompressDir", () => {
  test("compresses a large compressible file and skips a small one", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "big.js"), "x".repeat(5000));
    writeFileSync(join(dir, "small.css"), "a{}");

    const results = await precompressDir(dir, ["gzip", "br", "zstd"]);
    const files = results.map((r) => r.file);

    expect(files.filter((f) => f.endsWith("big.js"))).toHaveLength(3);
    expect(files.some((f) => f.endsWith("small.css"))).toBe(false);
    expect(await Bun.file(join(dir, "big.js.gz")).exists()).toBe(true);
    expect(await Bun.file(join(dir, "big.js.br")).exists()).toBe(true);
    expect(await Bun.file(join(dir, "big.js.zst")).exists()).toBe(true);
  });

  test("never re-compresses a file already ending in a compressed suffix", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "already.js.gz"), "x".repeat(5000));

    const results = await precompressDir(dir, ["gzip"]);
    expect(results).toHaveLength(0);
  });

  test("incompressible random bytes produce no variant", async () => {
    const dir = tmpDir();
    const random = crypto.getRandomValues(new Uint8Array(5000));
    writeFileSync(join(dir, "random.json"), random);

    const results = await precompressDir(dir, ["gzip", "br", "zstd"]);
    expect(results).toHaveLength(0);
  });

  test("non-compressible extensions are skipped regardless of size", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "image.png"), "x".repeat(5000));

    const results = await precompressDir(dir, ["gzip"]);
    expect(results).toHaveLength(0);
  });

  test("results are ordered by path, then by the requested encoding order", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "b.js"), "x".repeat(5000));
    writeFileSync(join(dir, "a.css"), "y".repeat(5000));

    const results = await precompressDir(dir, ["zstd", "gzip"]);
    expect(results.map((r) => `${basename(r.file)}${r.encoding}`)).toEqual([
      "a.csszstd",
      "a.cssgzip",
      "b.jszstd",
      "b.jsgzip",
    ]);
  });

  test("descends into subdirectories and dot-directories", async () => {
    const dir = tmpDir();
    mkdirSync(join(dir, "assets"));
    mkdirSync(join(dir, ".well-known"));
    writeFileSync(join(dir, "assets", "app.js"), "x".repeat(5000));
    writeFileSync(join(dir, ".well-known", "a.json"), "x".repeat(5000));

    const results = await precompressDir(dir, ["gzip"]);
    expect(results.map((r) => r.file).sort()).toEqual([
      join(dir, ".well-known", "a.json"),
      join(dir, "assets", "app.js"),
    ]);
  });

  test("no encodings configured is a no-op", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "big.js"), "x".repeat(5000));
    expect(await precompressDir(dir, [])).toEqual([]);
  });
});

describe("compressedSize", () => {
  test("reads a precompressed sibling, otherwise compresses", async () => {
    const dir = tmpDir();
    const file = join(dir, "big.js");
    writeFileSync(file, "x".repeat(5000));

    expect(await precompressedSize(file, "gzip")).toBeUndefined();
    const computed = await compressedSize(file, "gzip");
    expect(computed).toBeLessThan(5000);

    writeFileSync(`${file}.gz`, "abc");
    expect(await precompressedSize(file, "gzip")).toBe(3);
    expect(await compressedSize(file, "gzip")).toBe(3);
  });
});

describe("build.precompress", () => {
  test("compresses the final, minified HTML", async () => {
    const root = tmpDir();
    writeFileSync(
      join(root, "index.html"),
      `<!doctype html>\n<html>\n<!-- gone -->\n${"<p>row</p>\n".repeat(300)}</html>\n`,
    );
    writeFileSync(
      join(root, "steambun.config.ts"),
      `export default { build: { precompress: ["gzip"], server: false } };\n`,
    );

    await build({ root });

    const html = await Bun.file(join(root, "dist/index.html")).text();
    expect(html).not.toContain("gone");
    const gz = await Bun.file(join(root, "dist/index.html.gz")).bytes();
    expect(gunzipSync(gz).toString()).toBe(html);
  });
});
