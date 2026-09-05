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
    const csp: string = headers["/*.html"]["Content-Security-Policy"];
    expect(csp).toContain("object-src 'none'");
    expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
  });
});
