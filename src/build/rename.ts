import { rename, rm, stat } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";

/** Old rel path from outDir ("/"-separated) → new rel path. */
export type RenameMap = Map<string, string>;

/** Strips the `./` prefix Bun's metafile puts on output paths. */
export function stripDotSlash(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

/** Drops an href's `?query` / `#hash` suffix. */
export function cleanHref(href: string): string {
  return href.split("?")[0]!.split("#")[0]!;
}

/** A `base`-prefixed absolute href → the `outDir`-relative path it names. */
export function stripBase(href: string, base: string): string {
  return href.slice(base.length).replace(/^\/+/, "");
}

/** "/"-separated path relative to `outDir` → filesystem path. */
export function outPath(outDir: string, rel: string): string {
  return join(outDir, ...rel.split("/"));
}

/** Filesystem path → "/"-separated path relative to `outDir`. */
export function outRel(outDir: string, path: string): string {
  return relative(outDir, path).split(sep).join("/");
}

/** `rel` as an href from the HTML file's directory, always `./`- or `../`-prefixed. */
export function relativeHref(htmlDirRel: string, rel: string): string {
  const fromHtml = posix.relative(htmlDirRel, rel);
  return fromHtml.startsWith(".") ? fromHtml : `./${fromHtml}`;
}

/** New hash for rewritten content; renames `-<old>.<ext>` → `-<new>.<ext>`. */
export function rehashedName(rel: string, text: string | Uint8Array): string {
  const newHash = Bun.hash(text).toString(36).slice(0, 8);
  return rel.replace(/-[a-z0-9]+(\.[^./]+)$/, `-${newHash}$1`);
}

/**
 * Writes `content` to `newRel`. When the name changed, removes the old file
 * and moves its `.map` sidecar (if any) alongside the new one.
 */
export async function writeRenamed(
  outDir: string,
  rel: string,
  newRel: string,
  content: string,
): Promise<void> {
  const newPath = outPath(outDir, newRel);
  await Bun.write(newPath, content);
  if (newRel === rel) return;

  const oldPath = outPath(outDir, rel);
  await rm(oldPath);
  await rename(`${oldPath}.map`, `${newPath}.map`).catch((err) => {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  });
}

/** Composes two rename passes: apply `a` then `b` (`b`'s keys are `a`'s values). */
export function mergeRenames(a: RenameMap, b: RenameMap): RenameMap {
  const merged: RenameMap = new Map();
  const chainedFromB = new Set<string>();

  for (const [oldPath, midPath] of a) {
    const finalPath = b.get(midPath);
    if (finalPath !== undefined) chainedFromB.add(midPath);
    merged.set(oldPath, finalPath ?? midPath);
  }
  for (const [oldPath, newPath] of b) {
    if (chainedFromB.has(oldPath)) continue;
    merged.set(oldPath, newPath);
  }

  return merged;
}

function renameRef(path: string, renames: RenameMap): string {
  const renamed = renames.get(stripDotSlash(path));
  return renamed ? `./${renamed}` : path;
}

/**
 * Rewrites a metafile's output keys, `cssBundle` references, and inter-chunk
 * `imports[*].path` entries through `renames`. Entries with no matching
 * rename are returned unchanged (same reference).
 */
export function renameMetafileOutputs(
  metafile: Bun.BuildMetafile,
  renames: RenameMap,
): Bun.BuildMetafile {
  if (renames.size === 0) return metafile;

  const outputs: Bun.BuildMetafile["outputs"] = {};
  for (const [path, output] of Object.entries(metafile.outputs)) {
    const newKey = renameRef(path, renames);
    const touchedCss =
      !!output.cssBundle && renames.has(stripDotSlash(output.cssBundle));
    const touchedImports = output.imports.some((imp) =>
      renames.has(stripDotSlash(imp.path)),
    );

    if (newKey === path && !touchedCss && !touchedImports) {
      outputs[newKey] = output;
      continue;
    }

    outputs[newKey] = {
      ...output,
      ...(touchedCss
        ? { cssBundle: renameRef(output.cssBundle!, renames) }
        : {}),
      ...(touchedImports
        ? {
            imports: output.imports.map((imp) => ({
              ...imp,
              path: renameRef(imp.path, renames),
            })),
          }
        : {}),
    };
  }

  return { ...metafile, outputs };
}

/**
 * Replaces each `outputs[key].bytes` with the file's on-disk size under
 * `outDir` (a key with no file on disk keeps its metafile value).
 * `inputs[*].bytesInOutput` is left as-is: per-input attribution after CSS
 * extraction is only approximate, and not worth recomputing here.
 */
export async function refreshOutputSizes(
  metafile: Bun.BuildMetafile,
  outDir: string,
): Promise<Bun.BuildMetafile> {
  const entries = Object.entries(metafile.outputs);
  const sizes = await Promise.all(
    entries.map(([path, output]) =>
      stat(outPath(outDir, stripDotSlash(path)))
        .then((s) => s.size)
        .catch(() => output.bytes),
    ),
  );

  // Rebuilt in `entries` order so the metafile's key order survives.
  const outputs: Bun.BuildMetafile["outputs"] = {};
  entries.forEach(([path, output], i) => {
    const bytes = sizes[i]!;
    outputs[path] = bytes === output.bytes ? output : { ...output, bytes };
  });
  return { ...metafile, outputs };
}

/** Maps `outputs[*].path` through `renames`; entries with no rename are untouched. */
export function renameArtifacts(
  outputs: Bun.BuildArtifact[],
  renames: RenameMap,
  outDir: string,
): Array<{ kind: Bun.BuildArtifact["kind"]; path: string }> {
  return outputs.map((artifact) => {
    const renamed = renames.get(outRel(outDir, artifact.path));
    return {
      kind: artifact.kind,
      path: renamed ? outPath(outDir, renamed) : artifact.path,
    };
  });
}
