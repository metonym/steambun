import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { BunPlugin } from "../config/types";
import { toPosix } from "./specifier";

// `*.server.ts` (Remix's convention) and anything under `api` hold server
// code — database clients, secrets read from process.env — that must never
// be bundled for the browser. Type-only imports are erased before
// resolution, so `import type` from either stays allowed.

const SERVER_SPECIFIER = /\.server(\.[cm]?[jt]sx?)?$/;
const SERVER_FILE = /\.server\.[cm]?[jt]sx?$/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Fails a client bundle that imports a `*.server.*` module or a file under
 * `api`. `steambun dev` and `build` add it ahead of every other plugin, so an
 * alias can't resolve a `.server` import before it's checked. A package's
 * own `.server` files are left alone: only relative, root-absolute, and
 * `alias` specifiers are project code.
 */
export function createServerBoundaryPlugin(
  root: string,
  api?: string,
  alias?: Record<string, string>,
): BunPlugin {
  const aliasKeys = Object.keys(alias ?? {});
  const isProjectSpecifier = (spec: string) =>
    spec.startsWith("./") ||
    spec.startsWith("../") ||
    spec.startsWith("/") ||
    aliasKeys.some(
      (key) =>
        spec === key || spec.startsWith(key.endsWith("/") ? key : `${key}/`),
    );
  // Bun reports real paths (macOS's /var is /private/var).
  const real = (path: string) => (existsSync(path) ? realpathSync(path) : path);
  const realRoot = real(root);
  const rel = (path: string) => toPosix(relative(realRoot, path));
  const apiDir = api
    ? real(isAbsolute(api) ? api : join(root, api))
    : undefined;
  return {
    name: "steambun-server-boundary",
    setup(build) {
      // onResolve sees the importer, so it names the offending import.
      build.onResolve({ filter: SERVER_SPECIFIER }, (args) => {
        if (
          args.importer.includes("/node_modules/") ||
          !isProjectSpecifier(args.path)
        ) {
          return undefined;
        }
        throw new Error(
          `[steambun] ${rel(args.importer)} imports "${args.path}", a server-only module (*.server.*), into client code. Move the shared part to a module without ".server", or use \`import type\`.`,
        );
      });
      // A backstop for paths the specifier didn't reveal: API route files
      // (reached through any relative path or alias) and `.server` files
      // resolved some other way.
      const loadFilters = [SERVER_FILE];
      if (apiDir) {
        const dir = toPosix(apiDir)
          .split("/")
          .map(escapeRegExp)
          .join("[\\\\/]");
        loadFilters.push(new RegExp(`^${dir}[\\\\/]`));
      }
      for (const filter of loadFilters) {
        build.onLoad({ filter }, (args) => {
          if (args.path.includes("/node_modules/")) return undefined;
          throw new Error(
            `[steambun] ${rel(args.path)} is server-only (${filter === SERVER_FILE ? "*.server.*" : "under `api`"}) but is part of a client bundle. Move the shared part out, or use \`import type\`.`,
          );
        });
      }
    },
  };
}
