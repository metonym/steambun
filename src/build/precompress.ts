import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import {
  brotliCompress,
  gzip as gzipCb,
  constants as zlibConstants,
} from "node:zlib";
import { CPU_CONCURRENCY, mapLimit } from "./concurrency";

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

const DEPLOY_METADATA_FILES = new Set([
  "_headers",
  "_redirects",
  "vercel.json",
]);

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzipCb);

/**
 * Compresses `bytes` at the levels steambun ships everywhere (gzip 9,
 * brotli 11, zstd 19). All three run off the main thread, so callers should
 * fan out with `Promise.all` / `mapLimit` rather than awaiting one at a time.
 */
export async function compress(
  bytes: Uint8Array<ArrayBuffer>,
  encoding: Encoding,
): Promise<Uint8Array> {
  switch (encoding) {
    case "gzip":
      return gzipAsync(bytes, { level: 9 });
    case "br":
      return brotliAsync(bytes, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
        },
      });
    case "zstd":
      return Bun.zstdCompress(bytes, { level: 19 });
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

export interface PrecompressResult {
  file: string;
  encoding: Encoding;
  bytes: number;
}

/**
 * Writes `.gz` / `.br` / `.zst` siblings for compressible files at least
 * `minSize` bytes, skipping any variant that doesn't beat the original by
 * `MIN_SAVINGS_RATIO`. Files already ending in a compressed suffix are left
 * alone (running this twice, e.g. after a `publicDir` copy, is safe), as are
 * deploy metadata files and anything in `exclude`.
 *
 * Files are compressed concurrently, so results are sorted by path (then by
 * the caller's encoding order) to keep the build summary deterministic.
 */
export async function precompressDir(
  dir: string,
  encodings: Encoding[],
  minSize: number,
  /** Absolute paths never to compress, e.g. the `dist/server.js` bundle. */
  exclude: ReadonlySet<string> = new Set(),
): Promise<PrecompressResult[]> {
  if (encodings.length === 0) return [];
  const files = (await collectFiles(dir)).filter((file) => {
    if (file.endsWith(".gz") || file.endsWith(".br") || file.endsWith(".zst")) {
      return false;
    }
    if (DEPLOY_METADATA_FILES.has(basename(file)) || exclude.has(file)) {
      return false;
    }
    return COMPRESSIBLE.has(extname(file));
  });
  files.sort();

  const perFile = await mapLimit(files, CPU_CONCURRENCY, async (file) => {
    const source = Bun.file(file);
    if (source.size < minSize) return [];
    const buf = await source.bytes();
    const variants = await Promise.all(
      encodings.map((encoding) => compress(buf, encoding)),
    );

    const written: PrecompressResult[] = [];
    await Promise.all(
      variants.map(async (compressed, i) => {
        if (compressed.length > buf.length * MIN_SAVINGS_RATIO) return;
        const encoding = encodings[i]!;
        await Bun.write(`${file}${EXTENSION[encoding]}`, compressed);
        written.push({ file, encoding, bytes: compressed.length });
      }),
    );
    written.sort(
      (a, b) => encodings.indexOf(a.encoding) - encodings.indexOf(b.encoding),
    );
    return written;
  });

  return perFile.flat();
}
