import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { group, task } from "ostia";
import { precompressDir } from "../src/build/precompress";

// ~400 KB of JS + 20 small pages.
const dir = mkdtempSync(join(tmpdir(), "steambun-precompress-bench-"));
mkdirSync(join(dir, "assets"));
let vendor = "";
for (let i = 0; i < 4000; i++) {
  vendor += `function f${i}(a,b){if(a>${i}){return a*b+${i}+"s${i}"}return String(a)+String(b)+"x${i}"}\n`;
}
writeFileSync(join(dir, "assets", "vendor-abcdefgh.js"), vendor);
let styles = "";
for (let i = 0; i < 400; i++) {
  styles += `.c${i}{color:#${(i % 16).toString(16).repeat(6)};padding:${i}px}\n`;
}
writeFileSync(join(dir, "assets", "shared-abcdefgh.css"), styles);
for (let p = 0; p < 20; p++) {
  writeFileSync(
    join(dir, `page${p}.html`),
    `<!doctype html><html><head><link rel="stylesheet" href="./assets/shared-abcdefgh.css"></head><body>${"<p>row</p>".repeat(200)}</body></html>`,
  );
}

async function clean(): Promise<void> {
  for (const ext of [".gz", ".br", ".zst"]) {
    for await (const f of new Bun.Glob(`**/*${ext}`).scan(dir)) {
      await rm(join(dir, f));
    }
  }
}

group("build/precompress: precompressDir (dist-like tree, 22 files)", () => {
  task("gzip only", async () => {
    await precompressDir(dir, ["gzip"]);
    await clean();
  });
  task("gzip+zstd", async () => {
    await precompressDir(dir, ["gzip", "zstd"]);
    await clean();
  });
  task("gzip+br+zstd", async () => {
    await precompressDir(dir, ["gzip", "br", "zstd"]);
    await clean();
  });
});
