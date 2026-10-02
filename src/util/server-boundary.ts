import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { BunPlugin } from "../config/types";
import { aliasEntries, matchAlias, VITE_SUFFIX } from "./alias";
import { resolveFrom } from "./paths";
import { escapeRegExp } from "./regexp";
import { posixRelative, toPosix } from "./specifier";

const SERVER_SPECIFIER = /\.server(\.[cm]?[jt]sx?)?$/;
const SERVER_FILE = /\.server\.[cm]?[jt]sx?$/;
const NODE_MODULES = /[\\/]node_modules[\\/]/;

/**
 * Fails a client bundle that imports a `*.server.*` module or a file under `api`. It must run
 * ahead of the alias plugin so an alias can't resolve a `.server` import before it's checked.
 * Only relative, root-absolute, and `alias` specifiers count as project code; dependencies'
 * own `.server` files are left alone.
 */
export function createServerBoundaryPlugin(
  root: string,
  api?: string,
  alias?: Record<string, string>,
): BunPlugin {
  const aliases = aliasEntries(alias, root);
  const isProjectSpecifier = (spec: string) =>
    spec.startsWith("./") ||
    spec.startsWith("../") ||
    spec.startsWith("/") ||
    matchAlias(spec, aliases) !== undefined;
  // Bun reports real paths (macOS's /var is /private/var).
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const realRoot = real(root);
  const rel = (path: string) => posixRelative(realRoot, path);
  const apiDir = api ? real(resolveFrom(root, api)) : undefined;
  return {
    name: "steambun-server-boundary",
    setup(build) {
      // onResolve sees the importer, so it names the offending import.
      build.onResolve({ filter: SERVER_SPECIFIER }, (args) => {
        if (
          NODE_MODULES.test(args.importer) ||
          !isProjectSpecifier(args.path)
        ) {
          return undefined;
        }
        throw new Error(
          `[steambun] ${rel(args.importer)} imports "${args.path}", a server-only module (*.server.*), into client code. Move the shared part to a module without ".server", or use \`import type\`.`,
        );
      });
      // Backstop for paths the specifier didn't reveal (tsconfig paths, any alias into `api`).
      const backstops: Array<[filter: RegExp, label: string]> = [
        [SERVER_FILE, "*.server.*"],
      ];
      if (apiDir) {
        const dir = toPosix(apiDir)
          .split("/")
          .map(escapeRegExp)
          .join("[\\\\/]");
        backstops.push([new RegExp(`^${dir}[\\\\/]`), "under `api`"]);
      }
      for (const [filter, label] of backstops) {
        build.onLoad({ filter }, (args) => {
          if (NODE_MODULES.test(args.path)) return undefined;
          throw new Error(
            `[steambun] ${rel(args.path)} is server-only (${label}) but is part of a client bundle. Move the shared part out, or use \`import type\`.`,
          );
        });
      }
      // `?raw`/`?url`/`?inline` load their file without `onLoad`, so check the file they resolve to.
      build.onResolve({ filter: VITE_SUFFIX }, (args) => {
        if (NODE_MODULES.test(args.importer)) return undefined;
        const file = VITE_SUFFIX.exec(args.path)![1]!;
        const aliased = matchAlias(file, aliases);
        let path: string;
        try {
          path = real(
            Bun.resolveSync(
              aliased ? join(aliased.to, aliased.rest) : file,
              args.resolveDir,
            ),
          );
        } catch {
          return undefined;
        }
        if (NODE_MODULES.test(path)) return undefined;
        const label = backstops.find(([filter]) => filter.test(path))?.[1];
        if (!label) return undefined;
        throw new Error(
          `[steambun] ${rel(args.importer)} imports "${args.path}", a server-only module (${label}), into client code. Move the shared part out, or use \`import type\`.`,
        );
      });
    },
  };
}
