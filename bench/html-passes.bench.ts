import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { group, task } from "ostia";
import {
  applySri,
  collectInlineHashes,
  createSriHasher,
} from "../src/build/security";

const PAGES = 20;

// 20 pages all referencing the same 400 KB vendor chunk and one shared
// stylesheet: the per-page SRI re-hash of shared assets is the point here.
const outDir = mkdtempSync(join(tmpdir(), "steambun-html-passes-bench-"));
mkdirSync(join(outDir, "assets"));
let vendor = "";
for (let i = 0; i < 4000; i++) {
  vendor += `function f${i}(a,b){if(a>${i}){return a*b+${i}+"s${i}"}return String(a)+String(b)+"x${i}"}\n`;
}
writeFileSync(join(outDir, "assets", "vendor-abcdefgh.js"), vendor);
writeFileSync(join(outDir, "assets", "shared-abcdefgh.css"), ".a{color:red}");

const pages = Array.from({ length: PAGES }, (_, p) => {
  const name = `page${p}.html`;
  const html = `<!doctype html><html><head><link rel="stylesheet" href="./assets/shared-abcdefgh.css"><style>.p${p}{color:#0${p % 10}0}</style></head><body><p>row</p><script src="./assets/vendor-abcdefgh.js"></script><script>console.log(${p})</script></body></html>`;
  writeFileSync(join(outDir, name), html);
  return { html, dir: outDir };
});

const quiet = () => {};

group(`build/security: SRI + inline hashes over ${PAGES} pages`, () => {
  task("applySri x20 sequential", async () => {
    for (const p of pages) await applySri(p.html, outDir, p.dir, "/", quiet);
  });
  task("applySri x20 under Promise.all", () =>
    Promise.all(pages.map((p) => applySri(p.html, outDir, p.dir, "/", quiet))),
  );
  task("applySri x20 under Promise.all, one shared hasher", () => {
    const hasher = createSriHasher(outDir, "/");
    return Promise.all(
      pages.map((p) => applySri(p.html, outDir, p.dir, "/", quiet, hasher)),
    );
  });
  task("collectInlineHashes x20 sequential", async () => {
    for (const p of pages) await collectInlineHashes(p.html);
  });
});
