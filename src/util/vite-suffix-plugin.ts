import type { BunPlugin } from "../config/types";

const SUFFIX_RE = /^(.*)\?(raw|url|inline)$/;
const NAMESPACE_PREFIX = "steambun-vite-suffix-";
// Bun's bundler dedupes resolved modules by path alone, ignoring namespace —
// two suffixes on the same file (e.g. `?raw` and `?url`) would otherwise
// collapse into one binding (one onLoad result reused for both, or a
// self-referencing `var x = x` when `?url`'s re-export targets the same
// clean path as another suffix's virtual module). A per-suffix marker
// keeps every resolved path unique; onLoad strips it back off.
const MARKERS: Record<string, string> = {
  raw: "\0steambun-vite-raw:",
  url: "\0steambun-vite-url:",
  inline: "\0steambun-vite-inline:",
};

function realPathOf(markedPath: string, suffix: string): string {
  return markedPath.slice(MARKERS[suffix]!.length);
}

/**
 * Vite's `?raw` / `?url` / `?inline` import-suffix convention, shimmed as a
 * Bun plugin. Enabled by `resolve.viteSuffixes: true` — applies in both
 * `dev` (through a `.steambun/plugin-*.ts` wrapper) and `build`.
 *
 * - `?raw` — the file's contents as a string export.
 * - `?url` — a `type: "file"` re-export (a hashed asset URL at build time).
 * - `?inline` — a `data:` URL of the file's contents.
 */
export function createViteSuffixPlugin(): BunPlugin {
  return {
    name: "steambun-vite-suffixes",
    setup(build) {
      build.onResolve({ filter: SUFFIX_RE }, (args) => {
        const match = args.path.match(SUFFIX_RE);
        if (!match) return undefined;
        const [, specifier, suffix] = match as [string, string, string];
        const resolved = Bun.resolveSync(specifier, args.resolveDir);
        return {
          path: `${MARKERS[suffix]}${resolved}`,
          namespace: `${NAMESPACE_PREFIX}${suffix}`,
        };
      });

      build.onLoad(
        { filter: /.*/, namespace: `${NAMESPACE_PREFIX}raw` },
        async (args) => {
          const text = await Bun.file(realPathOf(args.path, "raw")).text();
          return {
            contents: `export default ${JSON.stringify(text)};`,
            loader: "js",
          };
        },
      );

      build.onLoad(
        { filter: /.*/, namespace: `${NAMESPACE_PREFIX}url` },
        (args) => {
          const realPath = realPathOf(args.path, "url");
          return {
            contents: `import u from ${JSON.stringify(realPath)} with { type: "file" };\nexport default u;\n`,
            loader: "js",
          };
        },
      );

      build.onLoad(
        { filter: /.*/, namespace: `${NAMESPACE_PREFIX}inline` },
        async (args) => {
          const realPath = realPathOf(args.path, "inline");
          const file = Bun.file(realPath);
          const bytes = await file.bytes();
          const mime = file.type || "application/octet-stream";
          const base64 = Buffer.from(bytes).toString("base64");
          const dataUrl = `data:${mime};base64,${base64}`;
          return {
            contents: `export default ${JSON.stringify(dataUrl)};`,
            loader: "js",
          };
        },
      );
    },
  };
}
