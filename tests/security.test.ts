import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../src/build/build";
import {
  applySri,
  buildCspString,
  collectInlineHashes,
} from "../src/build/security";

function sha384(content: string): string {
  const hasher = new Bun.CryptoHasher("sha384");
  hasher.update(content);
  return `sha384-${hasher.digest("base64")}`;
}

function sha256(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return `sha256-${hasher.digest("base64")}`;
}

describe("applySri", () => {
  test("adds integrity + crossorigin to a local script and stylesheet", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "steambun-sri-"));
    mkdirSync(join(outDir, "assets"));
    const jsContent = "console.log('hi')";
    const cssContent = "body{color:red}";
    writeFileSync(join(outDir, "assets", "app.js"), jsContent);
    writeFileSync(join(outDir, "assets", "app.css"), cssContent);

    const html =
      '<html><head><link rel="stylesheet" href="./assets/app.css">' +
      '<script src="./assets/app.js"></script></head><body></body></html>';

    const result = await applySri(html, outDir, outDir);

    expect(result).toContain(`integrity="${sha384(jsContent)}"`);
    expect(result).toContain(`integrity="${sha384(cssContent)}"`);
    expect(result).toContain('crossorigin="anonymous"');
  });

  test("skips an external script and a missing file", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "steambun-sri-ext-"));
    const html =
      '<script src="https://cdn.example.com/x.js"></script>' +
      '<script src="./missing.js"></script>';
    const result = await applySri(html, outDir, outDir);
    expect(result).not.toContain("integrity=");
  });

  test("warns and leaves the tag untouched when a local file is missing", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "steambun-sri-missing-"));
    const html = '<script src="./missing.js"></script>';
    const warnings: string[] = [];

    const result = await applySri(html, outDir, outDir, "/", (m) =>
      warnings.push(m),
    );

    expect(result).toBe(html);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("./missing.js");
  });

  test("resolves absolute sources against base, not htmlDir", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "steambun-sri-base-"));
    mkdirSync(join(outDir, "assets"));
    const jsContent = "console.log('base')";
    const cssContent = "body{color:blue}";
    writeFileSync(join(outDir, "assets", "app.js"), jsContent);
    writeFileSync(join(outDir, "assets", "app.css"), cssContent);

    const html =
      '<script src="/mybase/assets/app.js"></script>' +
      '<link rel="stylesheet" href="/mybase/assets/app.css">';

    const result = await applySri(html, outDir, outDir, "/mybase/");

    expect(result).toContain(`integrity="${sha384(jsContent)}"`);
    expect(result).toContain(`integrity="${sha384(cssContent)}"`);
    expect(result).toContain('crossorigin="anonymous"');
  });

  test("default base still resolves relative and absolute sources", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "steambun-sri-default-"));
    mkdirSync(join(outDir, "assets"));
    const relContent = "console.log('rel')";
    const absContent = "console.log('abs')";
    writeFileSync(join(outDir, "assets", "rel.js"), relContent);
    writeFileSync(join(outDir, "assets", "abs.js"), absContent);

    const html =
      '<script src="./assets/rel.js"></script>' +
      '<script src="/assets/abs.js"></script>';

    const result = await applySri(html, outDir, outDir);

    expect(result).toContain(`integrity="${sha384(relContent)}"`);
    expect(result).toContain(`integrity="${sha384(absContent)}"`);
  });
});

describe("collectInlineHashes / buildCspString", () => {
  test("hashes one inline script and builds the strict CSP string", async () => {
    const script = 'console.log("inline")';
    const html = `<html><head><script>${script}</script></head><body></body></html>`;

    const hashes = await collectInlineHashes(html);
    expect(hashes.script).toEqual([sha256(script)]);
    expect(hashes.style).toEqual([]);

    const csp = buildCspString("strict", hashes);
    expect(csp).toBe(
      `default-src 'self'; script-src 'self' '${sha256(script)}'; style-src 'self'; object-src 'none'; base-uri 'self'`,
    );
  });

  test("an object form merges hashes into the user's directives", () => {
    const csp = buildCspString(
      { "default-src": ["'none'"], "img-src": ["'self'", "https:"] },
      { script: ["sha256-abc"], style: [] },
    );
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src 'self' https:");
    expect(csp).toContain("script-src 'sha256-abc'");
  });

  test("omits script-src/style-src entirely when there is nothing to put in them", () => {
    const csp = buildCspString(
      { "default-src": ["'self'"] },
      { script: [], style: [] },
    );
    expect(csp).toBe("default-src 'self'");
  });

  test("emits only the hashes when script-src is omitted but there are inline scripts", () => {
    const csp = buildCspString(
      { "default-src": ["'self'"] },
      { script: ["sha256-abc"], style: [] },
    );
    expect(csp).toBe("default-src 'self'; script-src 'sha256-abc'");
  });

  test("strict output is unchanged", () => {
    const csp = buildCspString("strict", { script: [], style: [] });
    expect(csp).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'",
    );
  });

  test("warns and drops a user-supplied directive with no sources", () => {
    const warnings: string[] = [];
    const csp = buildCspString(
      { "default-src": ["'self'"], "img-src": [] },
      { script: [], style: [] },
      (m) => warnings.push(m),
    );
    expect(csp).toBe("default-src 'self'");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("img-src");
  });
});

describe("build() with build.csp", () => {
  test("writes _headers.json with a CSP covering the page's inline script", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-csp-build-"));
    writeFileSync(
      join(dir, "index.html"),
      `<!doctype html><html><body><script>console.log("hi")</script></body></html>\n`,
    );
    writeFileSync(
      join(dir, "steambun.config.ts"),
      `export default { build: { csp: "strict", server: false } };\n`,
    );

    await build({ root: dir });

    const headers = JSON.parse(
      await Bun.file(join(dir, "dist", "_headers.json")).text(),
    );
    const csp: string = headers["/**/*.html"]["Content-Security-Policy"];
    expect(csp).toContain("object-src 'none'");
    expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
  });
});
