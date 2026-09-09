import { join, resolve, sep } from "node:path";
import { cleanHref, stripBase } from "./rename";

function isExternalSrc(src: string): boolean {
  return /^([a-z][a-z0-9+.-]*:)?\/\//i.test(src) || src.startsWith("data:");
}

// Absolute `src` values (e.g. `/mybase/assets/x.js`) are rooted at `base`,
// not at the HTML file's own directory, so they resolve against `outDir`
// after stripping the `base` prefix. Relative `src` values resolve against
// `htmlDir`, matching how a browser would. A path that escapes `outDir` is
// not hashed.
function resolveSriPath(
  outDir: string,
  htmlDir: string,
  src: string,
  base: string,
): string | null {
  const cleanSrc = cleanHref(src);
  const filePath = cleanSrc.startsWith("/")
    ? join(outDir, stripBase(cleanSrc, cleanSrc.startsWith(base) ? base : "/"))
    : join(htmlDir, cleanSrc);

  const resolvedOutDir = resolve(outDir);
  const resolvedFilePath = resolve(filePath);
  if (
    resolvedFilePath !== resolvedOutDir &&
    !resolvedFilePath.startsWith(resolvedOutDir + sep)
  ) {
    return null;
  }
  return resolvedFilePath;
}

async function hashFile(path: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;

  const hasher = new Bun.CryptoHasher("sha384");
  hasher.update(await file.bytes());
  return `sha384-${hasher.digest("base64")}`;
}

/** Resolves an HTML `src`/`href` to its `sha384-...` integrity value, or `null`. */
export type SriHasher = (
  htmlDir: string,
  src: string,
) => Promise<string | null>;

/**
 * An `SriHasher` that hashes each resolved file once. A vendor chunk linked
 * from 20 pages is read and digested once instead of 20 times, so one hasher
 * should be shared across a build's pages.
 */
export function createSriHasher(outDir: string, base: string): SriHasher {
  const cache = new Map<string, Promise<string | null>>();
  return (htmlDir, src) => {
    const path = resolveSriPath(outDir, htmlDir, src, base);
    if (!path) return Promise.resolve(null);
    let hash = cache.get(path);
    if (!hash) {
      hash = hashFile(path);
      cache.set(path, hash);
    }
    return hash;
  };
}

/**
 * Adds `integrity`/`crossorigin="anonymous"` to every local `<script src>`
 * and `<link rel="stylesheet" href>` in `html` (an external URL, or one
 * outside `outDir`, is left untouched). `htmlDir` is the directory the HTML
 * output file lives in — relative `src`/`href` are resolved against it,
 * absolute ones against `outDir` (after stripping `base`), matching how a
 * browser would. Pass a shared `hasher` to reuse digests across pages.
 */
export async function applySri(
  html: string,
  outDir: string,
  htmlDir: string,
  base = "/",
  warn: (message: string) => void = console.warn,
  hasher: SriHasher = createSriHasher(outDir, base),
): Promise<string> {
  async function addIntegrity(el: HTMLRewriterTypes.Element, attr: string) {
    const src = el.getAttribute(attr);
    if (!src) return;
    if (isExternalSrc(src)) return;
    const hash = await hasher(htmlDir, src);
    if (!hash) {
      warn(
        `[steambun] sri: could not find ${src} for ${htmlDir} — no integrity added`,
      );
      return;
    }
    el.setAttribute("integrity", hash);
    if (!el.hasAttribute("crossorigin")) {
      el.setAttribute("crossorigin", "anonymous");
    }
  }

  const rewriter = new HTMLRewriter()
    .on("script[src]", {
      element: (el) => addIntegrity(el, "src"),
    })
    .on("link[rel=stylesheet][href]", {
      element: (el) => addIntegrity(el, "href"),
    });

  return rewriter.transform(new Response(html)).text();
}

export interface InlineHashes {
  script: string[];
  style: string[];
}

// Buffers text across the (possibly chunked) text nodes of one element at a
// time, hashing on that element's end tag — `.on()`'s handler object is
// shared across every match, so state must reset per element, not per call.
function inlineCollector(
  target: string[],
): HTMLRewriterTypes.HTMLRewriterElementContentHandlers {
  let buffer = "";
  return {
    element(el) {
      buffer = "";
      el.onEndTag(() => {
        if (buffer.trim().length === 0) return;
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update(buffer);
        target.push(`sha256-${hasher.digest("base64")}`);
      });
    },
    text(chunk) {
      buffer += chunk.text;
    },
  };
}

/** Hashes every inline (no `src`) `<script>` and every `<style>` in `html`. */
export async function collectInlineHashes(html: string): Promise<InlineHashes> {
  const script: string[] = [];
  const style: string[] = [];

  const rewriter = new HTMLRewriter()
    .on("script:not([src])", inlineCollector(script))
    .on("style", inlineCollector(style));

  await rewriter.transform(new Response(html)).text();
  return { script, style };
}

const STRICT_DIRECTIVES: Record<string, string[]> = {
  "default-src": ["'self'"],
  "script-src": ["'self'"],
  "style-src": ["'self'"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
};

function mergeDirective(
  existing: string[] | undefined,
  extra: string[],
): string[] {
  return [...new Set([...(existing ?? []), ...extra])];
}

/** Builds a `Content-Security-Policy` header value from `csp`, merging in `hashes`. */
export function buildCspString(
  csp: "strict" | Record<string, string[]>,
  hashes: InlineHashes,
  warn: (message: string) => void = console.warn,
): string {
  const directives: Record<string, string[]> = {
    ...(csp === "strict" ? STRICT_DIRECTIVES : csp),
  };
  directives["script-src"] = mergeDirective(
    directives["script-src"],
    hashes.script.map((h) => `'${h}'`),
  );
  directives["style-src"] = mergeDirective(
    directives["style-src"],
    hashes.style.map((h) => `'${h}'`),
  );

  return Object.entries(directives)
    .filter(([key, values]) => {
      if (values.length > 0) return true;
      // script-src/style-src are auto-seeded above; ending up empty just
      // means "no inline content", not a mistake, so drop them quietly and
      // let default-src govern instead.
      if (key !== "script-src" && key !== "style-src") {
        warn(
          `[steambun] csp: directive "${key}" has no sources and was dropped`,
        );
      }
      return false;
    })
    .map(([key, values]) => `${key} ${values.join(" ")}`)
    .join("; ");
}
