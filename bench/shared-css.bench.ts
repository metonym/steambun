import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { group, task } from "ostia";
import { extractSharedCss } from "../src/build/shared-css";

const PAGES = 20;

// A 20-page project where every page imports the same 400-rule `shared.css`
// plus its own small stylesheet — one shared group across all pages.
const root = mkdtempSync(join(tmpdir(), "steambun-shared-css-bench-"));
mkdirSync(join(root, "src"));
let shared = "";
for (let i = 0; i < 400; i++) {
  shared += `.s${i}{color:#${(i % 16).toString(16).repeat(6)};padding:${i}px}\n`;
}
writeFileSync(join(root, "src", "shared.css"), shared);

const htmlNames: string[] = [];
for (let p = 0; p < PAGES; p++) {
  const name = `page${p}.html`;
  htmlNames.push(name);
  writeFileSync(
    join(root, "src", `page${p}.css`),
    `.p${p}{margin:${p}px;border:1px solid #ccc}\n`,
  );
  writeFileSync(
    join(root, name),
    `<!doctype html><html><head><link rel="stylesheet" href="./src/shared.css"><link rel="stylesheet" href="./src/page${p}.css"></head><body>${"<p>row</p>".repeat(50)}</body></html>`,
  );
}

const template = join(root, "dist-template");
const built = await Bun.build({
  entrypoints: htmlNames.map((n) => join(root, n)),
  outdir: template,
  root,
  naming: {
    entry: "[dir]/[name].[ext]",
    chunk: "assets/[name]-[hash].[ext]",
    asset: "assets/[name]-[hash].[ext]",
  },
  metafile: true,
  minify: true,
  target: "browser",
});
if (!built.success || !built.metafile) {
  for (const log of built.logs) console.error(log);
  throw new Error("bench/shared-css: fixture build failed");
}
const metafile = built.metafile;

const copies: string[] = [];
function freshDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "steambun-shared-css-dist-"));
  cpSync(template, dir, { recursive: true });
  copies.push(dir);
  return dir;
}

group(`build/shared-css: extractSharedCss (${PAGES} pages, 1 group)`, () => {
  task("copy the dist fixture only (control)", () => {
    freshDist();
  });
  task("copy + extractSharedCss", async () => {
    const outDir = freshDist();
    await extractSharedCss({
      outDir,
      assetsDir: "assets",
      base: "/",
      metafile,
      minSize: 1024,
      minify: true,
      htmlFiles: htmlNames.map((n) => join(outDir, n)),
    });
  });
});

process.on("exit", () => {
  rmSync(root, { recursive: true, force: true });
  for (const dir of copies) rmSync(dir, { recursive: true, force: true });
});
