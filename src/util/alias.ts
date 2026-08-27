import { isAbsolute, join } from "node:path";
import type { BunPlugin } from "../config/types";

function resolveAliasTarget(to: string, root: string): string {
  return isAbsolute(to) ? to : join(root, to);
}

/**
 * Vite-shaped `resolve.alias` as a Bun `onResolve` plugin.
 *
 * @example
 * ```ts
 * import { createAliasPlugin } from "steambun/runtime";
 *
 * const plugin = createAliasPlugin({ "@": "./src" }, import.meta.dir);
 * await Bun.build({ entrypoints: ["./index.html"], plugins: [plugin] });
 * ```
 */
export function createAliasPlugin(
  alias: Record<string, string>,
  root: string,
): BunPlugin {
  const entries = Object.entries(alias)
    .map(([from, to]) => [from, resolveAliasTarget(to, root)] as const)
    .sort((a, b) => b[0].length - a[0].length);

  return {
    name: "steambun-alias",
    setup(build) {
      if (entries.length === 0) return;
      build.onResolve({ filter: /.*/ }, (args) => {
        const spec = args.path;
        if (
          spec.startsWith("./") ||
          spec.startsWith("../") ||
          spec.startsWith("/") ||
          spec.startsWith("file:")
        ) {
          return undefined;
        }
        for (const [from, to] of entries) {
          if (spec === from) return { path: to };
          const prefix = from.endsWith("/") ? from : `${from}/`;
          if (spec.startsWith(prefix)) {
            return { path: join(to, spec.slice(prefix.length)) };
          }
        }
        return undefined;
      });
    },
  };
}
