import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../src/build/build";
import {
  mergeHeaderRules,
  toNetlifyHeaders,
  toRedirects,
  toVercelJson,
} from "../src/build/deploy";

describe("mergeHeaderRules", () => {
  test("a glob only in base passes through", () => {
    const merged = mergeHeaderRules({ "/a": { "X-A": "1" } }, {});
    expect(merged).toEqual({ "/a": { "X-A": "1" } });
  });

  test("a glob only in overrides passes through", () => {
    const merged = mergeHeaderRules({}, { "/b": { "X-B": "2" } });
    expect(merged).toEqual({ "/b": { "X-B": "2" } });
  });

  test("a glob in both merges, overrides winning on a colliding key and both surviving on a non-colliding key", () => {
    const merged = mergeHeaderRules(
      { "/c": { "X-Shared": "base", "X-Base-Only": "base" } },
      { "/c": { "X-Shared": "override", "X-Override-Only": "override" } },
    );
    expect(merged).toEqual({
      "/c": {
        "X-Shared": "override",
        "X-Base-Only": "base",
        "X-Override-Only": "override",
      },
    });
  });
});

describe("toNetlifyHeaders", () => {
  test("a ** glob becomes /*", () => {
    const text = toNetlifyHeaders({ "/**/*.html": { "X-A": "1" } });
    expect(text.split("\n")[0]).toBe("/*");
  });

  test("a non-** glob is used verbatim", () => {
    const text = toNetlifyHeaders({ "/assets/*": { "X-A": "1" } });
    expect(text.split("\n")[0]).toBe("/assets/*");
  });

  test("multiple header keys each render on their own indented line", () => {
    const text = toNetlifyHeaders({ "/assets/*": { "X-A": "1", "X-B": "2" } });
    expect(text).toBe("/assets/*\n  X-A: 1\n  X-B: 2");
  });

  test("multiple globs are separated by a blank line", () => {
    const text = toNetlifyHeaders({
      "/assets/*": { "X-A": "1" },
      "/other/*": { "X-B": "2" },
    });
    expect(text).toBe("/assets/*\n  X-A: 1\n\n/other/*\n  X-B: 2");
  });
});

describe("toRedirects", () => {
  test("spa returns the SPA fallback line", () => {
    expect(toRedirects("spa")).toBe("/* /index.html 200\n");
  });

  test("mpa returns an empty string", () => {
    expect(toRedirects("mpa")).toBe("");
  });
});

describe("toVercelJson", () => {
  test("shape of one rule", () => {
    const config = toVercelJson({ "/assets/*": { "X-A": "1" } }, "mpa");
    expect(config.headers).toEqual([
      { source: "/assets/*", headers: [{ key: "X-A", value: "1" }] },
    ]);
  });

  test("spa adds the rewrite", () => {
    const config = toVercelJson({}, "spa");
    expect(config.rewrites).toEqual([
      { source: "/(.*)", destination: "/index.html" },
    ]);
  });

  test("mpa's rewrites is empty", () => {
    const config = toVercelJson({}, "mpa");
    expect(config.rewrites).toEqual([]);
  });
});

describe("build() with build.deploy", () => {
  test("writes _headers, _redirects, and _headers.json for netlify", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-deploy-build-"));
    writeFileSync(
      join(dir, "index.html"),
      `<!doctype html><html><body><script>console.log("hi")</script></body></html>\n`,
    );
    writeFileSync(
      join(dir, "steambun.config.ts"),
      `export default { build: { csp: "strict", deploy: "netlify", server: false } };\n`,
    );

    await build({ root: dir });

    const headers = await Bun.file(join(dir, "dist", "_headers")).text();
    expect(headers).toContain("/*");
    expect(headers).toContain("Content-Security-Policy");

    const redirects = await Bun.file(join(dir, "dist", "_redirects")).text();
    expect(redirects).toContain("/* /index.html 200");

    const headersJson = JSON.parse(
      await Bun.file(join(dir, "dist", "_headers.json")).text(),
    );
    expect(Object.keys(headersJson)).toContain("/**/*.html");
  });
});
