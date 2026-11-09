import { join } from "node:path";
import type { BunPlugin } from "../config/types";
import { resolveFrom } from "./paths";
import { escapeRegExp } from "./regexp";

/** `file.txt?raw`-style specifiers (`raw`, `url`, or `inline` anywhere in an `&`-joined query), which the vite-suffix plugin resolves itself (aliases included). */
export const VITE_SUFFIX = /^([^?]*)\?((?:[^&]*&)*(?:raw|url|inline)(?:&.*)?)$/;

export type AliasEntry = readonly [from: string, to: string];

/** Alias targets made absolute against `root`, longest key first. */
export function aliasEntries(
  alias: Record<string, string> | undefined,
  root: string,
): AliasEntry[] {
  return Object.entries(alias ?? {})
    .map(([from, to]) => [from, resolveFrom(root, to)] as const)
    .sort((a, b) => b[0].length - a[0].length);
}

/** Splits `spec` into an alias target and the remainder beneath it. */
export function matchAlias(
  spec: string,
  entries: readonly AliasEntry[],
): { to: string; rest: string } | undefined {
  for (const [from, to] of entries) {
    if (spec === from) return { to, rest: "" };
    const prefix = from.endsWith("/") ? from : `${from}/`;
    if (spec.startsWith(prefix)) return { to, rest: spec.slice(prefix.length) };
  }
  return undefined;
}

/** Vite-shaped `resolve.alias` as a Bun `onResolve` plugin. */
export function createAliasPlugin(
  alias: Record<string, string>,
  root: string,
): BunPlugin {
  const entries = aliasEntries(alias, root);

  return {
    name: "steambun-alias",
    setup(build) {
      if (entries.length === 0) return;
      // A filter limited to the alias keys keeps Bun from calling into JS for every other import.
      const keys = entries.map(([from]) =>
        from.endsWith("/")
          ? escapeRegExp(from)
          : `${escapeRegExp(from)}(?:/|$)`,
      );
      build.onResolve(
        { filter: new RegExp(`^(?:${keys.join("|")})`) },
        (args) => {
          const spec = args.path;
          if (
            spec.startsWith("./") ||
            spec.startsWith("../") ||
            spec.startsWith("/") ||
            spec.startsWith("file:") ||
            VITE_SUFFIX.test(spec)
          ) {
            return undefined;
          }
          const match = matchAlias(spec, entries);
          if (!match) return undefined;
          const target = join(match.to, match.rest);
          // Bun takes a plugin's path verbatim, with no extension or index probing.
          try {
            return { path: Bun.resolveSync(target, args.resolveDir) };
          } catch {
            return { path: target };
          }
        },
      );
    },
  };
}
