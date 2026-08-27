import { describe, expect, test } from "bun:test";
import { minifyHtml } from "../src/build/html-minify";
import { shouldMinifyHtml } from "../src/build/options";

describe("shouldMinifyHtml", () => {
  test("follows whitespace minify", () => {
    expect(shouldMinifyHtml(true)).toBe(true);
    expect(shouldMinifyHtml("esbuild")).toBe(true);
    expect(shouldMinifyHtml("terser")).toBe(true);
    expect(shouldMinifyHtml(undefined)).toBe(true);
    expect(shouldMinifyHtml(false)).toBe(false);
    expect(shouldMinifyHtml({ whitespace: true })).toBe(true);
    expect(shouldMinifyHtml({ syntax: true })).toBe(false);
    expect(shouldMinifyHtml({ whitespace: false, syntax: true })).toBe(false);
  });
});

describe("minifyHtml", () => {
  test("collapses pretty-printed tag gaps", () => {
    expect(
      minifyHtml(`<!doctype html>
<html>
  <head>
    <title>x</title>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>
`),
    ).toBe(
      '<!doctype html><html><head><title>x</title></head><body><div id="app"></div></body></html>',
    );
  });

  test("keeps a single space between inline tags", () => {
    expect(minifyHtml("<span>a</span> <span>b</span>")).toBe(
      "<span>a</span> <span>b</span>",
    );
  });

  test("strips comments outside protected tags", () => {
    expect(minifyHtml("<!-- note --><p>ok</p>")).toBe("<p>ok</p>");
  });

  test("leaves script, style, and pre bodies intact", () => {
    const html = `<p>x</p>
<script type="module">
  const x = \`
  <h1>keep</h1>
\`;
</script>
<style>
  body { color: red; }
</style>
<pre>
  indented
</pre>`;
    const out = minifyHtml(html);
    expect(out).toContain("const x = `\n  <h1>keep</h1>\n`;");
    expect(out).toContain("body { color: red; }");
    expect(out).toContain("\n  indented\n");
    expect(out.startsWith("<p>x</p><script")).toBe(true);
  });
});
