import { join } from "node:path";

function isExternalSrc(src: string): boolean {
  return /^([a-z][a-z0-9+.-]*:)?\/\//i.test(src) || src.startsWith("data:");
}

async function sriHashFor(
  outDir: string,
  htmlDir: string,
  src: string,
): Promise<string | null> {
  if (isExternalSrc(src)) return null;
  const cleanSrc = src.split("?")[0]!.split("#")[0]!;
  const filePath = join(htmlDir, cleanSrc);
  if (!filePath.startsWith(outDir)) return null;

  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;

  const hasher = new Bun.CryptoHasher("sha384");
  hasher.update(await file.bytes());
  return `sha384-${hasher.digest("base64")}`;
}

/**
 * Adds `integrity`/`crossorigin="anonymous"` to every local `<script src>`
 * and `<link rel="stylesheet" href>` in `html` (an external URL, or one
 * outside `outDir`, is left untouched). `htmlDir` is the directory the HTML
 * output file lives in — `src`/`href` are resolved relative to it, matching
 * how the browser would.
 */
export async function applySri(
  html: string,
  outDir: string,
  htmlDir: string,
): Promise<string> {
  async function addIntegrity(el: HTMLRewriterTypes.Element, attr: string) {
    const src = el.getAttribute(attr);
    if (!src) return;
    const hash = await sriHashFor(outDir, htmlDir, src);
    if (!hash) return;
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
    .map(([key, values]) => `${key} ${values.join(" ")}`)
    .join("; ");
}
