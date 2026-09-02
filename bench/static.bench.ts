import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bench, do_not_optimize, group } from "mitata";
import { createStaticHandler } from "../src/runtime/static";

const outDir = mkdtempSync(join(tmpdir(), "steambun-static-bench-"));
writeFileSync(join(outDir, "index.html"), "<!doctype html><h1>spa</h1>");
writeFileSync(join(outDir, "foo.txt"), "hello");
writeFileSync(join(outDir, "empty.txt"), "");
mkdirSync(join(outDir, "dir"));
writeFileSync(join(outDir, "dir", "index.html"), "<!doctype html><h1>dir</h1>");

const spa = createStaticHandler({ outDir, spa: true });
const noSpa = createStaticHandler({ outDir, spa: false });

const fileReq = new Request("http://localhost:4173/foo.txt");
const dirReq = new Request("http://localhost:4173/dir/");
const spaReq = new Request("http://localhost:4173/app/route");
const missReq = new Request("http://localhost:4173/no-such-file");

group("runtime/static: createStaticHandler (per-request hot path)", () => {
  bench("file hit", async () => {
    do_not_optimize(await spa(fileReq));
  });
  bench("directory-to-index", async () => {
    do_not_optimize(await spa(dirReq));
  });
  bench("SPA fallback", async () => {
    do_not_optimize(await spa(spaReq));
  });
  bench("404 without spa", async () => {
    do_not_optimize(await noSpa(missReq));
  });
});
