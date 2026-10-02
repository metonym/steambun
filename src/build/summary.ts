import { stat } from "node:fs/promises";
import { extname, relative } from "node:path";
import { buildFileType, formatSize } from "../util/format";
import { log } from "../util/terminal";
import {
  COMPRESSIBLE,
  compressedSize,
  MIN_COMPRESS_SIZE,
  precompressedSize,
} from "./precompress";

const FILE_TYPE_RANK: Record<string, number> = { html: 0, css: 1, js: 2 };

/** html, then css, then js (other extensions last); ascending by size within each. */
export async function printBuildSummary(
  outDir: string,
  outputs: Bun.BuildArtifact[],
): Promise<void> {
  const rows = await Promise.all(
    outputs
      .filter((artifact) => artifact.kind !== "sourcemap")
      .map(async (artifact) => {
        const name = relative(outDir, artifact.path);
        const { size } = await stat(artifact.path);
        const gzip =
          size >= MIN_COMPRESS_SIZE && COMPRESSIBLE.has(extname(name))
            ? await compressedSize(artifact.path, "gzip")
            : await precompressedSize(artifact.path, "gzip");
        return { name, size, gzip };
      }),
  );
  rows.sort((a, b) => {
    const rankA = FILE_TYPE_RANK[buildFileType(a.name) ?? ""] ?? 3;
    const rankB = FILE_TYPE_RANK[buildFileType(b.name) ?? ""] ?? 3;
    return rankA - rankB || a.size - b.size;
  });

  const totalGzip = rows.reduce((sum, row) => sum + (row.gzip ?? 0), 0);
  const cells = [
    ...rows.map((row) => ({
      name: row.name,
      size: formatSize(row.size),
      gzip: row.gzip === undefined ? "" : `gzip: ${formatSize(row.gzip)}`,
    })),
    {
      name: "total",
      size: formatSize(rows.reduce((sum, row) => sum + row.size, 0)),
      gzip: totalGzip > 0 ? `gzip: ${formatSize(totalGzip)}` : "",
    },
  ];
  const width = (pick: (cell: (typeof cells)[number]) => string) =>
    Math.max(0, ...cells.map((cell) => pick(cell).length));
  const nameWidth = width((c) => c.name);
  const sizeWidth = width((c) => c.size);
  for (const { name, size, gzip } of cells) {
    log.info(
      `  ${name.padEnd(nameWidth)}  ${size.padStart(sizeWidth)}  ${gzip}`.trimEnd(),
    );
  }
}
