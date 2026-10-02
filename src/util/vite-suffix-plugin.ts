import { join } from "node:path";
import type { BunPlugin } from "../config/types";
import { aliasEntries, matchAlias, VITE_SUFFIX } from "./alias";

const VIRTUAL = /^\0steambun-vite-(raw|url|inline):(.*)$/s;
const NAMESPACE = "steambun-vite-suffix";

type Suffix = "raw" | "url" | "inline";

const loaders: Record<Suffix, (path: string) => Promise<string> | string> = {
  raw: async (path) =>
    `export default ${JSON.stringify(await Bun.file(path).text())};`,
  url: (path) =>
    `import u from ${JSON.stringify(path)} with { type: "file" };\nexport default u;\n`,
  inline: async (path) => {
    const file = Bun.file(path);
    const mime = file.type || "application/octet-stream";
    const base64 = Buffer.from(await file.bytes()).toString("base64");
    return `export default ${JSON.stringify(`data:${mime};base64,${base64}`)};`;
  },
};

/** Vite's precedence for combined queries: `?raw` beats `?inline` beats `?url` (so `?url&inline` is a data URL). */
function suffixOf(query: string): Suffix {
  const params = query.split("&");
  if (params.includes("raw")) return "raw";
  return params.includes("inline") ? "inline" : "url";
}

/**
 * Vite's `?raw` / `?url` / `?inline` import suffixes as a Bun plugin.
 * `?raw` is the file's text, `?url` a `type: "file"` re-export (a hashed asset URL in builds), and
 * `?inline` a base64 `data:` URL. The suffix may sit among other params (`?raw&x`). Pass `alias`
 * so `@/file.txt?raw` resolves.
 */
export function createViteSuffixPlugin(
  alias: Record<string, string> | undefined,
  root: string,
): BunPlugin {
  const aliases = aliasEntries(alias, root);
  return {
    name: "steambun-vite-suffixes",
    setup(build) {
      build.onResolve({ filter: VITE_SUFFIX }, (args) => {
        const match = VITE_SUFFIX.exec(args.path);
        if (!match) return undefined;
        const aliased = matchAlias(match[1]!, aliases);
        const target = aliased ? join(aliased.to, aliased.rest) : match[1]!;
        let resolved: string;
        try {
          resolved = Bun.resolveSync(target, args.resolveDir);
        } catch (cause) {
          throw new Error(
            `[steambun] cannot resolve "${args.path}" from ${args.resolveDir}: ${(cause as Error).message}`,
            { cause },
          );
        }
        // Bun dedupes modules by path alone, so each suffix needs its own path prefix or two suffixes on one file collapse into one binding.
        return {
          path: `\0steambun-vite-${suffixOf(match[2]!)}:${resolved}`,
          namespace: NAMESPACE,
        };
      });

      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, async (args) => {
        const [, suffix, path] = VIRTUAL.exec(args.path)!;
        return {
          contents: await loaders[suffix as Suffix](path!),
          loader: "js",
        };
      });
    },
  };
}
