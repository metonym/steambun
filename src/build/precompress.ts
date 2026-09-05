import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

export type Encoding = "gzip" | "br" | "zstd";

const EXTENSION: Record<Encoding, string> = {
  gzip: ".gz",
  br: ".br",
  zstd: ".zst",
};

export const COMPRESSIBLE = new Set([
  ".js",
  ".mjs",
  ".css",
  ".html",
  ".svg",
  ".json",
  ".txt",
  ".map",
  ".xml",
  ".wasm",
]);

// A variant only pays off if it beats the original by a meaningful margin —
// otherwise it's wasted disk and a wasted branch in the static handler.
const MIN_SAVINGS_RATIO = 0.95;

function compress(
  encoding: Encoding,
  buf: Uint8Array<ArrayBuffer>,
): Uint8Array {
  switch (encoding) {
    case "gzip":
      return Bun.gzipSync(buf, { level: 9 });
    case "br":
      return brotliCompressSync(buf, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
      });
    case "zstd":
      return Bun.zstdCompressSync(buf, { level: 19 });
  }
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
    } else {
      files.push(path);
    }
  }
  return files;
}

/**
 * Writes `.gz` / `.br` / `.zst` siblings for compressible files at least
 * `minSize` bytes, skipping any variant that doesn't beat the original by
 * `MIN_SAVINGS_RATIO`. Files already ending in a compressed suffix are left
 * alone (running this twice, e.g. after a `publicDir` copy, is safe).
 */
export async function precompressDir(
  dir: string,
  encodings: Encoding[],
  minSize: number,
): Promise<Array<{ file: string; encoding: Encoding; bytes: number }>> {
  if (encodings.length === 0) return [];
  const results: Array<{ file: string; encoding: Encoding; bytes: number }> =
    [];
  const files = await collectFiles(dir);

  for (const file of files) {
    if (file.endsWith(".gz") || file.endsWith(".br") || file.endsWith(".zst")) {
      continue;
    }
    if (!COMPRESSIBLE.has(extname(file))) continue;

    const source = Bun.file(file);
    if (source.size < minSize) continue;
    const buf = await source.bytes();

    for (const encoding of encodings) {
      const compressed = compress(encoding, buf);
      if (compressed.length > buf.length * MIN_SAVINGS_RATIO) continue;
      await Bun.write(`${file}${EXTENSION[encoding]}`, compressed);
      results.push({ file, encoding, bytes: compressed.length });
    }
  }

  return results;
}
