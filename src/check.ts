// `steambun check`: code stays in the runtime it was written for.
//
// The page runs in WebKit and the core runs in Bun. Walk each one's
// import graph from its entry and fail when:
//   - the page reaches `bun`, `bun:*` or `steambun/core`: Bun APIs that
//     don't exist in WebKit, or
//   - the core reaches `steambun/ui` or a component file (.svelte, .vue,
//     .tsx, .jsx): page code that needs the DOM.
// Shared modules that use neither are fine in both. Type-only imports are
// dropped first, so sharing types is fine too. The core's import of the
// page's HTML is how it serves the page, so the walk stops there.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import type { Resolved } from "./config.ts";

export interface Problem {
  side: "page" | "core";
  chain: string[];
  what: string;
}

const SCRIPT = /\.(ts|tsx|js|jsx|mjs|mts|svelte|vue)$/;
const COMPONENT = /\.(svelte|vue|tsx|jsx)$/;
// The framework's two runtimes, by their real paths: the same check works
// from an install (node_modules/steambun/ui) and from this repo (src/ui).
const RUNTIME = {
  ui: realpathSync(join(import.meta.dir, "ui/index.ts")),
  core: realpathSync(join(import.meta.dir, "core/index.ts")),
};
const ts = new Bun.Transpiler({ loader: "tsx" });
const tsOnly = new Bun.Transpiler({ loader: "ts" });

/** The modules a file imports at run time (not `import type`). */
function imports(file: string): string[] {
  let src = readFileSync(file, "utf8").replace(/^#!.*/, "");
  if (/\.(svelte|vue)$/.test(file))
    src = [...src.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1])
      .join("\n");
  const loader = /\.(ts|mts|svelte|vue)$/.test(file) ? "ts" : "tsx";
  try {
    return (loader === "ts" ? tsOnly : ts).scanImports(src).map((i) => i.path);
  } catch (e) {
    // Bun's parse error has the line but not the file.
    const pos = (e as BuildMessage).position;
    const at = pos ? `:${pos.line}:${pos.column}` : "";
    throw new Error(
      `${relative(process.cwd(), file)}${at}: ${(e as BuildMessage).message}`,
      { cause: e },
    );
  }
}

/** The scripts an HTML page loads. */
function htmlScripts(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)].map(
    (m) => m[1]!,
  );
}

function resolveFrom(spec: string, from: string): string | null {
  try {
    return Bun.resolveSync(spec, dirname(from));
  } catch {
    return null;
  }
}

/** Walk one side's graph; return the first chain to each bad import. */
function walk(
  side: "page" | "core",
  entries: string[],
  root: string,
  bad: (spec: string, file: string | null) => string | null,
  pages: string[] = [],
): Problem[] {
  const seen = new Set<string>();
  const out: Problem[] = [];
  const rel = (f: string) => relative(root, f);
  const go = (file: string, chain: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    const specs = extname(file) === ".html" ? htmlScripts(file) : imports(file);
    for (const spec of specs) {
      const target = resolveFrom(spec, file);
      const why = bad(spec, target);
      if (why) {
        out.push({ side, chain: [...chain, rel(file)], what: why });
        continue;
      }
      // Only walk the app's own files, not packages.
      if (
        !target ||
        target.includes("/node_modules/") ||
        !target.startsWith(root)
      )
        continue;
      if (side === "core" && extname(target) === ".html") {
        pages.push(target);
        continue;
      }
      if (SCRIPT.test(target) || extname(target) === ".html")
        go(target, [...chain, rel(file)]);
    }
  };
  for (const e of entries) if (existsSync(e)) go(e, []);
  return out;
}

export function check(c: Resolved): Problem[] {
  const root = realpathSync(c.root); // imports resolve to real paths
  const core = c.core ? join(root, c.core) : null;
  const fw = (spec: string, target: string | null, sub: "ui" | "core") =>
    spec === `steambun/${sub}` || (!!target && target === RUNTIME[sub]);
  // With a core, the pages are the HTML files it imports.
  const pages: string[] = [];
  const coreProblems = core
    ? walk(
        "core",
        [core],
        root,
        (spec, target) => {
          if (fw(spec, target, "ui"))
            return "imports steambun/ui, the page's runtime";
          if (
            target &&
            COMPONENT.test(target) &&
            !target.includes("/node_modules/")
          )
            return `imports ${relative(root, target)}, a page component`;
          return null;
        },
        pages,
      )
    : [];
  const pageProblems = walk(
    "page",
    core ? pages : [join(root, c.page)],
    root,
    (spec, target) => {
      if (spec === "bun" || spec.startsWith("bun:"))
        return `imports ${spec}, a Bun API`;
      if (fw(spec, target, "core"))
        return "imports steambun/core, the core's runtime";
      if (core && target === core) return "imports the core's entry";
      return null;
    },
  );
  return [...pageProblems, ...coreProblems];
}

/**
 * The page's HTML entries: `page` with no core, or with a core, the HTML
 * files the core imports to serve.
 */
export function pageEntries(c: Resolved): string[] {
  const root = realpathSync(c.root);
  if (!c.core) return [join(root, c.page)];
  const pages: string[] = [];
  walk("core", [join(root, c.core)], root, () => null, pages);
  return [...new Set(pages)];
}

export function report(ps: Problem[]): string {
  return ps
    .map(
      (p) =>
        `${p.side === "page" ? "page (WebKit)" : "core (Bun)"}: ${p.chain.at(-1)} ${p.what}\n` +
        `  via ${p.chain.join(" → ")}`,
    )
    .join("\n");
}
