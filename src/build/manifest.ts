import { buildFileType } from "../util/format";
import { stripDotSlash } from "./analyze";

interface ManifestChunk {
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

// Bun tags the JS chunk, CSS bundle, and HTML file of an HTML entrypoint with the same `entryPoint`.
export function buildManifest(metafile: {
  outputs: Record<string, MetafileOutput>;
}): Manifest {
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
  for (const outputs of groups.values()) {
    const ofType = (type: string) =>
      outputs.find((o) => buildFileType(o.path) === type);
    // `entryPoint` is relative to Bun's cwd, not `root`; the HTML output keeps the entry's root-relative path.
    const src = stripDotSlash((ofType("html") ?? outputs[0]!).path);
    const primary = ofType("js") ?? ofType("html") ?? outputs[0]!;

    const chunk: ManifestChunk = {
      file: stripDotSlash(primary.path),
      src,
      isEntry: true,
    };
    const cssBundle = outputs.find((o) => o.output.cssBundle)?.output.cssBundle;
    if (cssBundle) chunk.css = [stripDotSlash(cssBundle)];

    manifest[src] = chunk;
  }

  return manifest;
}
