import { dirname } from "node:path";
import { assertBuildSuccess, type BunMinify } from "./options";
import type { RenameMap } from "./rename";
import {
  outPath,
  outRel,
  rehashedName,
  relativeHref,
  stripDotSlash,
  writeRenamed,
} from "./rename";

export interface CssGroup {
  /** Sorted page list, joined. */
  key: string;
  /** entryPoint values (HTML pages) that all include every input below. */
  pages: string[];
  /** CSS source input paths, in the first (alphabetically) sharing page's order. */
  inputs: string[];
}

export type LinkPosition = "before" | "after";

/** Groups CSS source inputs by the exact set of pages that include them; drops single-page groups. */
export function groupSharedCssInputs(metafile: Bun.BuildMetafile): CssGroup[] {
  const cssOutputs: Array<{ page: string; inputs: string[] }> = [];
  for (const [path, output] of Object.entries(metafile.outputs)) {
    if (!path.endsWith(".css") || !output.entryPoint) continue;
    cssOutputs.push({
      page: output.entryPoint,
      inputs: Object.keys(output.inputs),
    });
  }
  cssOutputs.sort((a, b) => a.page.localeCompare(b.page));

  const pagesForInput = new Map<string, Set<string>>();
  for (const { page, inputs } of cssOutputs) {
    for (const input of inputs) {
      const pages = pagesForInput.get(input) ?? new Set<string>();
      pages.add(page);
      pagesForInput.set(input, pages);
    }
  }

  const groups = new Map<string, CssGroup>();
  for (const { inputs } of cssOutputs) {
    for (const input of inputs) {
      const pages = [...pagesForInput.get(input)!].sort();
      if (pages.length < 2) continue;
      const key = pages.join(",");
      const group = groups.get(key) ?? { key, pages, inputs: [] };
      if (!group.inputs.includes(input)) group.inputs.push(input);
      groups.set(key, group);
    }
  }

  return [...groups.values()];
}

/**
 * Cuts the first occurrence of `sharedCss` out of `pageCss`. Only a span at
 * the very start or very end (ignoring trailing whitespace) counts; a match
 * in the middle, or no match, returns `null`.
 */
export function cutSpan(
  pageCss: string,
  sharedCss: string,
): { rest: string; position: LinkPosition } | null {
  const idx = pageCss.indexOf(sharedCss);
  if (idx === -1) return null;

  const before = pageCss.slice(0, idx);
  const after = pageCss.slice(idx + sharedCss.length);

  if (before.trim() === "") return { rest: after, position: "before" };
  if (after.trim() === "") return { rest: before, position: "after" };
  return null;
}

function sharedLinkTag(href: string): string {
  return `<link rel="stylesheet" crossorigin href="${href}">`;
}

/**
 * Updates the page's own stylesheet `href` to `renamedHref` and inserts a
 * `<link>` for each shared file before/after it, preserving `shared`'s
 * order. Pure.
 */
async function insertSharedLinks(
  html: string,
  opts: {
    pageCssHref: string;
    renamedHref: string;
    shared: Array<{ href: string; position: LinkPosition }>;
  },
): Promise<string> {
  const { pageCssHref, renamedHref, shared } = opts;
  const before = shared.filter((s) => s.position === "before");
  const after = shared.filter((s) => s.position === "after");

  const rewriter = new HTMLRewriter().on("link[rel=stylesheet]", {
    element(el) {
      if (el.getAttribute("href") !== pageCssHref) return;
      if (renamedHref !== pageCssHref) el.setAttribute("href", renamedHref);
      for (const b of before) el.before(sharedLinkTag(b.href), { html: true });
      for (const a of [...after].reverse()) {
        el.after(sharedLinkTag(a.href), { html: true });
      }
    },
  });

  return rewriter.transform(new Response(html)).text();
}

function toHref(htmlDirRel: string, rel: string, base: string): string {
  return base === "/" ? relativeHref(htmlDirRel, rel) : base + rel;
}

async function buildSharedText(
  inputs: string[],
  minify: BunMinify,
): Promise<string> {
  const result = await Bun.build({
    entrypoints: inputs,
    minify,
    target: "browser",
  });
  assertBuildSuccess(
    result,
    "[steambun] build.sharedCss: failed to build a shared CSS group.",
  );
  const cssOutputs = result.outputs.filter(
    (o) => o.kind !== "sourcemap" && o.path.endsWith(".css"),
  );
  const parts = await Promise.all(cssOutputs.map((o) => o.text()));
  return parts.join("").trim();
}

interface ResolvedGroup {
  group: CssGroup;
  text: string;
  rel: string;
}

/**
 * Equivalence guard: re-assembles a page's CSS from its surviving cuts in
 * document order (`before` texts, the trimmed `rest`, `after` texts) and
 * checks it against the original, byte for byte. `trimEnd` absorbs the one
 * class of tolerated difference — a trailing newline at the page CSS's own
 * outer boundary, which Bun's minifier always appends — without masking a
 * real mismatch.
 */
export function reconstructionMatches(
  cuts: Array<{ text: string; position: LinkPosition }>,
  rest: string,
  original: string,
): boolean {
  const beforeText = cuts
    .filter((c) => c.position === "before")
    .map((c) => c.text);
  const afterText = cuts
    .filter((c) => c.position === "after")
    .map((c) => c.text);
  const reconstructed = beforeText.join("") + rest + afterText.join("");
  return reconstructed.trimEnd() === original.trimEnd();
}

export interface SharedCssResult {
  renames: RenameMap;
  sharedFiles: string[];
  /** entryPoint (e.g. "index.html") → shared files linked into that page, for the manifest. */
  sharedByPage: Record<string, string[]>;
  skipped: Array<{ page: string; reason: string }>;
  savedBytes: number;
}

/** One page's outcome, aggregated afterwards in `htmlFiles` order. */
type PageOutcome =
  | { page: string; skipped: string }
  | {
      page: string;
      cssRel: string;
      newCssRel: string;
      cuts: Array<{ rel: string; text: string; position: LinkPosition }>;
    }
  | null;

/**
 * Extracts CSS shared by two or more pages into `assetsDir/shared-<hash>.css`
 * files, cutting the matching verbatim span out of each page's own CSS
 * output and linking the shared file in its place. A page whose shared block
 * isn't a clean prefix/suffix span, or whose reconstructed CSS doesn't match
 * the original byte for byte, is left unmodified and recorded as skipped.
 */
export async function extractSharedCss(opts: {
  outDir: string;
  assetsDir: string;
  base: string;
  metafile: Bun.BuildMetafile;
  minSize: number;
  minify: BunMinify;
  htmlFiles: string[];
}): Promise<SharedCssResult> {
  const { outDir, assetsDir, base, metafile, minSize, minify, htmlFiles } =
    opts;

  const groups = groupSharedCssInputs(metafile);
  const renames: RenameMap = new Map();
  const sharedFiles: string[] = [];
  const sharedByPage: Record<string, string[]> = {};
  const skipped: Array<{ page: string; reason: string }> = [];
  let savedBytes = 0;

  const cssRelByPage = new Map<string, string>();
  // entryPoint's exact format depends on the cwd/root Bun.build() ran with —
  // never re-derive it from a file path; always read it back off the
  // metafile's own ".html" output, which uses the same format.
  const entryPointByHtmlOutput = new Map<string, string>();
  for (const [path, output] of Object.entries(metafile.outputs)) {
    if (path.endsWith(".css") && output.entryPoint) {
      cssRelByPage.set(output.entryPoint, stripDotSlash(path));
    }
    if (path.endsWith(".html") && output.entryPoint) {
      entryPointByHtmlOutput.set(stripDotSlash(path), output.entryPoint);
    }
  }

  const texts = await Promise.all(
    groups.map((group) => buildSharedText(group.inputs, minify)),
  );
  const resolved: ResolvedGroup[] = [];
  for (const [i, group] of groups.entries()) {
    const text = texts[i]!;
    if (Buffer.byteLength(text) < minSize) continue;
    const hash = Bun.hash(text).toString(36).slice(0, 8);
    const rel = `${assetsDir}/shared-${hash}.css`;
    await Bun.write(outPath(outDir, rel), text);
    sharedFiles.push(rel);
    resolved.push({ group, text, rel });
  }

  // Two pages never share a CSS output (Bun emits one per entrypoint), so the
  // per-page writes are disjoint and can run concurrently. Results are folded
  // back in `htmlFiles` order so renames/skipped/sharedByPage stay stable.
  const outcomes: PageOutcome[] = await Promise.all(
    htmlFiles.map(async (htmlPath): Promise<PageOutcome> => {
      const page = entryPointByHtmlOutput.get(outRel(outDir, htmlPath));
      if (!page) return null;
      const cssRel = cssRelByPage.get(page);
      if (!cssRel) return null;

      const applicable = resolved.filter((rg) => rg.group.pages.includes(page));
      if (applicable.length === 0) return null;

      const original = await Bun.file(outPath(outDir, cssRel)).text();

      let rest = original;
      const cuts: Array<{ rel: string; text: string; position: LinkPosition }> =
        [];

      for (const rg of applicable) {
        const cut = cutSpan(rest, rg.text);
        if (!cut) {
          return {
            page,
            skipped: `shared block for "${rg.group.key}" is not a contiguous prefix/suffix`,
          };
        }
        rest = cut.rest;
        cuts.push({ rel: rg.rel, text: rg.text, position: cut.position });
      }

      if (!reconstructionMatches(cuts, rest, original)) {
        return {
          page,
          skipped: "reconstructed CSS did not match the original byte for byte",
        };
      }

      const newCssRel = rehashedName(cssRel, rest);
      const htmlDirRel = outRel(outDir, dirname(htmlPath));
      const html = await Bun.file(htmlPath).text();
      const updated = await insertSharedLinks(html, {
        pageCssHref: toHref(htmlDirRel, cssRel, base),
        renamedHref: toHref(htmlDirRel, newCssRel, base),
        shared: cuts.map((c) => ({
          href: toHref(htmlDirRel, c.rel, base),
          position: c.position,
        })),
      });

      await Promise.all([
        writeRenamed(outDir, cssRel, newCssRel, rest),
        updated === html ? undefined : Bun.write(htmlPath, updated),
      ]);

      return { page, cssRel, newCssRel, cuts };
    }),
  );

  for (const outcome of outcomes) {
    if (!outcome) continue;
    if ("skipped" in outcome) {
      skipped.push({ page: outcome.page, reason: outcome.skipped });
      continue;
    }
    renames.set(outcome.cssRel, outcome.newCssRel);
    sharedByPage[outcome.page] = outcome.cuts.map((c) => c.rel);
    savedBytes += outcome.cuts.reduce(
      (sum, c) => sum + Buffer.byteLength(c.text),
      0,
    );
  }

  return { renames, sharedFiles, sharedByPage, skipped, savedBytes };
}
