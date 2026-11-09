import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { group, task } from "ostia";
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
  task("file hit", () => spa(fileReq));
  task("directory-to-index", () => spa(dirReq));
  task("SPA fallback", () => spa(spaReq));
  task("404 without spa", () => noSpa(missReq));
});

// Full request paths through a realistic outDir.

const fullOutDir = mkdtempSync(join(tmpdir(), "steambun-static-full-"));
writeFileSync(join(fullOutDir, "index.html"), "<!doctype html><h1>spa</h1>");
mkdirSync(join(fullOutDir, "assets"));
writeFileSync(
  join(fullOutDir, "assets", "app-abc123.js"),
  "console.log(1)".repeat(200),
);
writeFileSync(join(fullOutDir, "assets", "app-abc123.js.gz"), "gz-bytes"); // only .gz exists
mkdirSync(join(fullOutDir, "docs"));
writeFileSync(join(fullOutDir, "docs", "page.html"), "<h1>doc</h1>");

const fullHandler = createStaticHandler({
  outDir: fullOutDir,
  spa: true,
  immutablePrefix: "/assets/",
  precompressed: true,
});

const BROWSER_AE = "gzip, deflate, br, zstd";
const assetReq = new Request("http://localhost:4173/assets/app-abc123.js");
const assetGzReq = new Request("http://localhost:4173/assets/app-abc123.js", {
  headers: { "accept-encoding": BROWSER_AE },
});
const docReq = new Request("http://localhost:4173/docs/page"); // extension-less html
const headReq = new Request("http://localhost:4173/docs/page.html", {
  method: "HEAD",
});
const deepSpaReq = new Request("http://localhost:4173/app/users/42/settings");

// If-None-Match needs the live etag: resolve it once before the task runs.
let etag = "";
const notModifiedReq = () =>
  new Request("http://localhost:4173/docs/page.html", {
    headers: { "if-none-match": etag },
  });

group("runtime/static: full request paths (per-request hot path)", () => {
  task("A1 asset hit under immutablePrefix, no Accept-Encoding", () =>
    fullHandler(assetReq),
  );
  task(
    "A2 html hit + If-None-Match -> 304",
    () => fullHandler(notModifiedReq()),
    {
      before: async () => {
        etag =
          (
            await fullHandler(
              new Request("http://localhost:4173/docs/page.html"),
            )
          ).headers.get("etag") ?? "";
      },
    },
  );
  task("A3 asset hit, AE=gzip,deflate,br,zstd, only .gz sibling", () =>
    fullHandler(assetGzReq),
  );
  task("A5 3-deep SPA fallback", () => fullHandler(deepSpaReq));
  task("A6 extension-less .html resolution", () => fullHandler(docReq));
  task("A7 HEAD hit", () => fullHandler(headReq));
});
