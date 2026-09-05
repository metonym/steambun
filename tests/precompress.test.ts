import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { precompressDir } from "../src/build/precompress";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "steambun-precompress-"));
}

describe("precompressDir", () => {
  test("compresses a large compressible file and skips a small one", async () => {
    const dir = tmpDir();
    // Repetitive text compresses well past the 5% savings bar at any level.
    writeFileSync(join(dir, "big.js"), "x".repeat(5000));
    writeFileSync(join(dir, "small.css"), "a{}");

    const results = await precompressDir(dir, ["gzip", "br", "zstd"], 1024);
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

    const results = await precompressDir(dir, ["gzip"], 1024);
    expect(results).toHaveLength(0);
  });

  test("incompressible random bytes produce no variant", async () => {
    const dir = tmpDir();
    const random = crypto.getRandomValues(new Uint8Array(5000));
    writeFileSync(join(dir, "random.json"), random);

    const results = await precompressDir(dir, ["gzip", "br", "zstd"], 1024);
    expect(results).toHaveLength(0);
  });

  test("non-compressible extensions are skipped regardless of size", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "image.png"), "x".repeat(5000));

    const results = await precompressDir(dir, ["gzip"], 1024);
    expect(results).toHaveLength(0);
  });

  test("no encodings configured is a no-op", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "big.js"), "x".repeat(5000));
    expect(await precompressDir(dir, [], 1024)).toEqual([]);
  });
});
