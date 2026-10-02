import { describe, expect, test } from "bun:test";
import { minifyHtml, shouldMinifyHtml } from "../src/build/html-minify";

describe("shouldMinifyHtml", () => {
  test("follows whitespace minify", () => {
    expect(shouldMinifyHtml(true)).toBe(true);
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

describe("minifyHtml inline whitespace and conditional comments", () => {
  test("keeps one space for a line break between inline elements", () => {
    expect(minifyHtml('<p><a href="/a">A</a>\n  <a href="/b">B</a></p>')).toBe(
      '<p><a href="/a">A</a> <a href="/b">B</a></p>',
    );
    expect(minifyHtml("<span>x</span>\n\n   <em>y</em>")).toBe(
      "<span>x</span> <em>y</em>",
    );
  });

  test("still collapses line breaks next to block elements", () => {
    expect(minifyHtml("<div>\n  <a>x</a>\n</div>\n<p>y</p>")).toBe(
      "<div><a>x</a></div><p>y</p>",
    );
  });

  test("treats a textarea neighbor as inline", () => {
    expect(minifyHtml("<span>x</span>\n<textarea>\n a\n</textarea>")).toBe(
      "<span>x</span> <textarea>\n a\n</textarea>",
    );
  });

  test("keeps IE conditional comments but strips ordinary ones", () => {
    const html = `<!--[if lt IE 9]><script src="shim.js"></script><![endif]-->
<!--[if !IE]><!-->
<p>modern</p>
<!--<![endif]-->
<!-- drop me -->
<p>x</p>`;
    expect(minifyHtml(html)).toBe(
      `<!--[if lt IE 9]><script src="shim.js"></script><![endif]--><!--[if !IE]><!--><p>modern</p><!--<![endif]--><p>x</p>`,
    );
  });
});
