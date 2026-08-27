// Bun's minify only covers JS/CSS, so the HTML shell stays indented unless
// compacted here. A single space between tags is kept (`</span> <span>`
// shouldn't collapse); script/style/pre/textarea bodies are left untouched.
export function minifyHtml(html: string): string {
  const protectedTag =
    /<(script|style|pre|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  let out = "";
  let last = 0;
  for (const match of html.matchAll(protectedTag)) {
    const start = match.index ?? 0;
    out += minifyMarkup(html.slice(last, start));
    out += match[0];
    last = start + match[0].length;
  }
  out += minifyMarkup(html.slice(last));
  return out.trim();
}

function minifyMarkup(chunk: string): string {
  if (!chunk) return chunk;
  return chunk
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>\s*\n\s*</g, "><")
    .replace(/^\s+(?=<)/, "")
    .replace(/(?<=>)\s+$/, "");
}
