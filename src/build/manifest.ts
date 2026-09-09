// Bun's metafile paths carry a "./" prefix (relative to outdir/root); strip
// it rather than re-deriving relativity, which would break under a different cwd.
import { stripDotSlash } from "./rename";

export interface ManifestChunk {
  file: string;
  src?: string;
  isEntry?: boolean;
  css?: string[];
}

export type Manifest = Record<string, ManifestChunk>;

interface MetafileOutput {
  entryPoint?: string;
  cssBundle?: string;
}

// Bun tags every output derived from an HTML entrypoint — JS chunk, CSS
// bundle, and the rewritten HTML file — with the same entryPoint, so outputs
// are grouped per entrypoint first and the JS chunk is picked as the file.
export function buildManifest(
  metafile: {
    outputs: Record<string, MetafileOutput>;
  },
  /** entryPoint (e.g. "index.html") → extra CSS files, e.g. build.sharedCss's output. */
  extraCss?: Record<string, string[]>,
): Manifest {
  const groups = new Map<
    string,
    Array<{ path: string; output: MetafileOutput }>
  >();

  for (const [outputPath, output] of Object.entries(metafile.outputs)) {
    if (!output.entryPoint) continue;
    const list = groups.get(output.entryPoint) ?? [];
    list.push({ path: outputPath, output });
    groups.set(output.entryPoint, list);
  }

  const manifest: Manifest = {};
  for (const [entryPoint, outputs] of groups) {
    const src = stripDotSlash(entryPoint);
    const jsOutput = outputs.find(
      (o) => !o.path.endsWith(".css") && !o.path.endsWith(".html"),
    );
    const primary =
      jsOutput ?? outputs.find((o) => o.path.endsWith(".html")) ?? outputs[0]!;

    const chunk: ManifestChunk = {
      file: stripDotSlash(primary.path),
      src,
      isEntry: true,
    };
    const cssBundle = outputs.find((o) => o.output.cssBundle)?.output.cssBundle;
    const css = cssBundle ? [stripDotSlash(cssBundle)] : [];
    css.push(...(extraCss?.[entryPoint] ?? []).map(stripDotSlash));
    if (css.length > 0) chunk.css = css;

    manifest[src] = chunk;
  }

  return manifest;
}
