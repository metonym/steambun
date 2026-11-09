import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
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

/** Files smaller than this are neither precompressed nor gzip-measured for the build summary. */
export const MIN_COMPRESS_SIZE = 1024;

const MIN_SAVINGS_RATIO = 0.95;

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzipCb);

/** gzip 9, brotli 11, zstd 19 — the levels steambun uses everywhere. All run off the main thread. */
async function compress(
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

/** Size of `path`'s `.gz`/`.br`/`.zst` sibling written by `precompressDir`, if any. */
export async function precompressedSize(
  path: string,
  encoding: Encoding,
): Promise<number | undefined> {
  const sibling = Bun.file(path + EXTENSION[encoding]);
  return (await sibling.exists()) ? sibling.size : undefined;
}

/** Reuses a precompressed sibling (same codec levels, so same bytes) before compressing. */
export async function compressedSize(
  path: string,
  encoding: Encoding,
): Promise<number> {
  return (
    (await precompressedSize(path, encoding)) ??
    (await compress(await Bun.file(path).bytes(), encoding)).length
  );
}

export interface PrecompressResult {
  file: string;
  encoding: Encoding;
  bytes: number;
}

/**
 * Writes `.gz`/`.br`/`.zst` siblings for compressible files of at least
 * `MIN_COMPRESS_SIZE` bytes, skipping variants that don't beat the original by
 * `MIN_SAVINGS_RATIO`. Existing compressed files and `exclude` are left alone.
 * Results are sorted by path, then `encodings` order.
 */
export async function precompressDir(
  dir: string,
  encodings: Encoding[],
  exclude: ReadonlySet<string> = new Set(),
): Promise<PrecompressResult[]> {
  if (encodings.length === 0) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .filter((file) => COMPRESSIBLE.has(extname(file)) && !exclude.has(file))
    .sort();

  const perFile = await mapLimit(files, CPU_CONCURRENCY, async (file) => {
    const source = Bun.file(file);
    if (source.size < MIN_COMPRESS_SIZE) return [];
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
