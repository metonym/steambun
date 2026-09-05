import { join, relative, sep } from "node:path";

/** Old rel path from outDir ("/"-separated) → new rel path. */
export type RenameMap = Map<string, string>;

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

function stripDotSlash(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
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

/** Maps `outputs[*].path` through `renames`; entries with no rename are untouched. */
export function renameArtifacts(
  outputs: Bun.BuildArtifact[],
  renames: RenameMap,
  outDir: string,
): Array<{ kind: Bun.BuildArtifact["kind"]; path: string }> {
  return outputs.map((artifact) => {
    const rel = relative(outDir, artifact.path).split(sep).join("/");
    const renamed = renames.get(rel);
    return {
      kind: artifact.kind,
      path: renamed ? join(outDir, renamed) : artifact.path,
    };
  });
}
