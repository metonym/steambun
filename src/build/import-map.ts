import { basename, dirname, posix, resolve } from "node:path";
import { escapeRegExp } from "../util/regexp";
import type { RenameMap } from "./rename";
import {
  cleanHref,
  outPath,
  outRel,
  rehashedName,
  relativeHref,
  stripBase,
  stripDotSlash,
  writeRenamed,
} from "./rename";

const CHUNK_MAP_FILE = ".steambun-chunks.json";

export interface ImportMapResult {
  renames: RenameMap;
  imports: Record<string, string>;
  chunkMap: Record<string, string>;
}

/** Content-independent id per JS output: `Bun.hash` of the sorted input paths, base36. */
export function stableChunkIds(
  metafile: Bun.BuildMetafile,
): Map<string, string> {
  const stable = new Map<string, string>();
  for (const [path, output] of Object.entries(metafile.outputs)) {
    if (!path.endsWith(".js")) continue;
    const id = Bun.hash(Object.keys(output.inputs).sort().join("\n")).toString(
      36,
    );
    stable.set(stripDotSlash(path), id);
  }
  return stable;
}

/** Filename hash token (the `[hash]` in `name-[hash].js`) → stable id. */
function hashTokenIds(stable: Map<string, string>): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const [rel, id] of stable) {
    const token = basename(rel).match(/-([a-z0-9]+)\.js$/)?.[1];
    if (token) tokens.set(token, id);
  }
  return tokens;
}

function chunkKey(base: string, id: string): string {
  return `${base}@chunk/${id}.js`;
}

const RELATIVE_JS_LITERAL = /(["'])(\.\.?\/[^"'\n]*?\.js)\1/g;

function resolveRelSpecifier(
  outDir: string,
  rel: string,
  spec: string,
): string {
  const importerDir = dirname(outPath(outDir, rel));
  return outRel(outDir, resolve(importerDir, spec));
}

interface RewriteCtx {
  rel: string;
  outDir: string;
  base: string;
  stable: Map<string, string>;
  tokens: Map<string, string>;
}

function rewriteSpecifiers(src: string, ctx: RewriteCtx): string {
  const { rel, outDir, base, stable } = ctx;

  let out = src.replace(
    RELATIVE_JS_LITERAL,
    (match, quote: string, spec: string) => {
      const target = resolveRelSpecifier(outDir, rel, spec);
      const id = stable.get(target);
      return id ? `${quote}${chunkKey(base, id)}${quote}` : match;
    },
  );

  if (base !== "/") {
    const absoluteLiteral = new RegExp(
      `(["'])(${escapeRegExp(base)}[^"'\n]*?\\.js)\\1`,
      "g",
    );
    out = out.replace(absoluteLiteral, (match, quote: string, spec: string) => {
      const target = stripBase(spec, base);
      const id = stable.get(target);
      return id ? `${quote}${chunkKey(base, id)}${quote}` : match;
    });
  }

  return out;
}

const HELPER_ANCHOR = "import.meta.url,[";

function findMatchingBracket(src: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function rewriteHelperTokens(src: string, tokens: Map<string, string>): string {
  if (tokens.size === 0) return src;
  // The global regex below matches every `ident("literal")` call in a
  // minified bundle; skip it entirely unless some token literal is present.
  let hasToken = false;
  for (const token of tokens.keys()) {
    if (src.includes(`"${token}"`)) {
      hasToken = true;
      break;
    }
  }
  if (!hasToken) return src;

  let out = src;
  const anchorIdx = out.indexOf(HELPER_ANCHOR);
  if (anchorIdx !== -1) {
    const openIdx = anchorIdx + HELPER_ANCHOR.length - 1;
    const closeIdx = findMatchingBracket(out, openIdx);
    if (closeIdx !== -1) {
      const before = out.slice(0, openIdx + 1);
      const region = out.slice(openIdx + 1, closeIdx);
      const after = out.slice(closeIdx);
      const rewrittenRegion = region.replace(
        /"([a-zA-Z0-9]+)"/g,
        (match, tok: string) =>
          tokens.has(tok) ? `"${tokens.get(tok)}"` : match,
      );
      out = before + rewrittenRegion + after;
    }
  }

  return out.replace(
    /\b([a-zA-Z_$][\w$]*)\("([a-zA-Z0-9]+)"\)/g,
    (match, fn: string, tok: string) =>
      tokens.has(tok) ? `${fn}("${tokens.get(tok)}")` : match,
  );
}

/**
 * Rewrites one chunk's source, pure. Static/dynamic import specifiers that
 * resolve to a known output become `chunkKey(base, id)`; the dynamic-import
 * preload helper's dep-table hash tokens are rewritten to the same stable
 * ids, anchored to the helper's own table (never a global replace).
 */
export function rewriteChunkSource(src: string, ctx: RewriteCtx): string {
  return rewriteHelperTokens(rewriteSpecifiers(src, ctx), ctx.tokens);
}

function rewriteHref(
  href: string,
  htmlDirRel: string,
  renames: RenameMap,
  base: string,
): string | null {
  const clean = cleanHref(href);
  const isAbsolute = base !== "/" && clean.startsWith(base);

  let rel: string;
  if (isAbsolute) {
    rel = stripBase(clean, base);
  } else if (clean.startsWith("/")) {
    return null;
  } else {
    rel = posix.normalize(posix.join(htmlDirRel, clean));
  }

  const renamed = renames.get(rel);
  if (!renamed) return null;
  return isAbsolute ? base + renamed : relativeHref(htmlDirRel, renamed);
}

const IMPORT_MAP_SCRIPT =
  /<script[^>]*\btype=["']importmap["'][^>]*>([\s\S]*?)<\/script>/i;

/**
 * Prepends the import map to `<head>` (or before the first `<script>` if
 * there's no `<head>`), or merges into an existing import map (ours win on
 * key conflicts). Updates `script[src]` / `link[rel=modulepreload][href]`
 * for renamed files. Pure.
 */
export async function injectImportMap(
  html: string,
  opts: {
    imports: Record<string, string>;
    renames: RenameMap;
    htmlDirRel: string;
    base: string;
    /** Called when the page already had an import map that ours merged into. */
    onMerge?: () => void;
  },
): Promise<string> {
  const { imports, renames, htmlDirRel, base } = opts;

  const existingMatch = html.match(IMPORT_MAP_SCRIPT);
  let mergedImports = imports;
  if (existingMatch) {
    opts.onMerge?.();
    try {
      const existing = JSON.parse(existingMatch[1] ?? "{}") as {
        imports?: Record<string, string>;
      };
      mergedImports = { ...(existing.imports ?? {}), ...imports };
    } catch {
      mergedImports = imports;
    }
  }
  const mapJson = JSON.stringify({ imports: mergedImports });
  const mapTag = `<script type="importmap">${mapJson}</script>`;

  function rewriteAttr(el: HTMLRewriterTypes.Element, attr: string) {
    const value = el.getAttribute(attr);
    if (!value) return;
    const newHref = rewriteHref(value, htmlDirRel, renames, base);
    if (newHref) el.setAttribute(attr, newHref);
  }

  let headSeen = false;
  let scriptInjected = false;

  const rewriter = new HTMLRewriter()
    .on("script[type=importmap]", {
      element(el) {
        el.setInnerContent(mapJson);
      },
    })
    .on("head", {
      element(el) {
        headSeen = true;
        if (!existingMatch) el.prepend(mapTag, { html: true });
      },
    })
    .on("script", {
      element(el) {
        if (existingMatch || headSeen || scriptInjected) return;
        scriptInjected = true;
        el.before(mapTag, { html: true });
      },
    })
    .on("script[src]", {
      element: (el) => rewriteAttr(el, "src"),
    })
    .on("link[rel=modulepreload][href]", {
      element: (el) => rewriteAttr(el, "href"),
    });

  return rewriter.transform(new Response(html)).text();
}

/** Orchestrates the pure functions above on disk. Writes `CHUNK_MAP_FILE` under `outDir`. */
export async function applyImportMap(opts: {
  outDir: string;
  base: string;
  metafile: Bun.BuildMetafile;
  htmlFiles: string[];
}): Promise<ImportMapResult> {
  const { outDir, base, metafile, htmlFiles } = opts;

  const stable = stableChunkIds(metafile);
  const tokens = hashTokenIds(stable);

  const rewritten = await Promise.all(
    [...stable].map(async ([rel, id]) => {
      const original = await Bun.file(outPath(outDir, rel)).text();
      const text = rewriteChunkSource(original, {
        rel,
        outDir,
        base,
        stable,
        tokens,
      });
      // A chunk with no inter-chunk imports (a leaf vendor chunk) comes back
      // byte for byte identical: leave it on disk under its own name rather
      // than rewriting it to a `Bun.hash`-derived one that means the same thing.
      if (text === original) return { rel, id, newRel: rel };
      const newRel = rehashedName(rel, text);
      await writeRenamed(outDir, rel, newRel, text);
      return { rel, id, newRel };
    }),
  );

  const renames: RenameMap = new Map();
  const imports: Record<string, string> = {};
  const chunkMap: Record<string, string> = {};
  for (const { rel, id, newRel } of rewritten) {
    renames.set(rel, newRel);
    imports[chunkKey(base, id)] = base + newRel;
    chunkMap[id] = newRel;
  }

  let mergedExisting = false;
  await Promise.all(
    htmlFiles.map(async (htmlPath) => {
      const html = await Bun.file(htmlPath).text();
      const updated = await injectImportMap(html, {
        imports,
        renames,
        htmlDirRel: outRel(outDir, dirname(htmlPath)),
        base,
        onMerge: () => {
          mergedExisting = true;
        },
      });
      if (updated !== html) await Bun.write(htmlPath, updated);
    }),
  );
  if (mergedExisting) {
    console.warn(
      '[steambun] build.importMap: merged into an existing <script type="importmap">.',
    );
  }

  await Bun.write(outPath(outDir, CHUNK_MAP_FILE), JSON.stringify(chunkMap));

  return { renames, imports, chunkMap };
}
