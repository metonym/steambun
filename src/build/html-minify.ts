import type { MinifyOption } from "../config/types";

const PROTECTED_TAG = /<(script|style|pre|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const STUB = /<(\w+)\0(\d+)\0><\/\1>/g;

// Whitespace between two of these is rendered as a space, so a line break there collapses to one space.
const INLINE_TAGS = new Set(
  (
    "a abbr acronym audio b bdi bdo big button canvas cite code data datalist del dfn em embed font i iframe img " +
    "input ins kbd label map mark math meter noscript object output picture progress q ruby s samp select slot " +
    "small span strong sub sup svg textarea time tt u var video"
  ).split(" "),
);

// Matches `<!--...-->` except IE conditional comments (`<!--[if IE]>...<![endif]-->`, `<!--[if !IE]><!-->`, `<!--<![endif]-->`).
const COMMENT = /<!--(?!\[if\b|\[endif\]|<!\[endif|>)[\s\S]*?-->/gi;

// A line-break gap between two tokens; element tags capture their name, comments/doctype don't (never inline).
const TAG_GAP =
  /(<\/?([a-zA-Z][\w-]*)[^<>]*>|<!--[\s\S]*?-->|<![^>]*>)\s*\n\s*(?=<(?:\/?([a-zA-Z][\w-]*)|!))/g;

// Bun's minifier only covers JS/CSS. Same-line whitespace between tags survives; script/style/pre/textarea bodies are untouched.
export function minifyHtml(html: string): string {
  const kept: string[] = [];
  const stubbed = html.replace(PROTECTED_TAG, (block, tag: string) => {
    kept.push(block);
    return `<${tag}\0${kept.length - 1}\0></${tag}>`;
  });
  return stubbed
    .replace(COMMENT, "")
    .replace(TAG_GAP, (_, tag: string, left?: string, right?: string) =>
      left &&
      right &&
      INLINE_TAGS.has(left.toLowerCase()) &&
      INLINE_TAGS.has(right.toLowerCase())
        ? `${tag} `
        : tag,
    )
    .replace(STUB, (_, _tag: string, i: string) => kept[Number(i)]!)
    .trim();
}

/** HTML whitespace is collapsed only when JS/CSS whitespace is (`minify: true` or `{ whitespace: true }`). */
export function shouldMinifyHtml(minify: MinifyOption): boolean {
  return typeof minify === "object" ? minify.whitespace === true : minify;
}
