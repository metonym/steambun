import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../src/build/build";
import { buildManifest } from "../src/build/manifest";

test("buildManifest groups an entry's JS, CSS bundle, and HTML under its source", () => {
  const manifest = buildManifest({
    outputs: {
      "./index.html": { entryPoint: "../../tmp/x/index.html" },
      "./assets/index-aaa.js": {
        entryPoint: "../../tmp/x/index.html",
        cssBundle: "./assets/index-bbb.css",
      },
      "./assets/index-bbb.css": { entryPoint: "../../tmp/x/index.html" },
      "./assets/chunk-ccc.js": {},
    },
  });
  expect(manifest).toEqual({
    "index.html": {
      file: "assets/index-aaa.js",
      src: "index.html",
      isEntry: true,
      css: ["assets/index-bbb.css"],
    },
  });
});

test("build.manifest writes manifest.json with the built file names", async () => {
  const root = mkdtempSync(join(tmpdir(), "steambun-manifest-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "about"));
  writeFileSync(
    join(root, "about/index.html"),
    "<!doctype html><p>about</p>\n",
  );
  writeFileSync(
    join(root, "index.html"),
    `<!doctype html><link rel="stylesheet" href="./src/a.css"><script type="module" src="./src/a.ts"></script>\n`,
  );
  writeFileSync(join(root, "src/a.css"), "body{color:red}\n");
  writeFileSync(join(root, "src/a.ts"), `console.log("a");\n`);
  writeFileSync(
    join(root, "steambun.config.ts"),
    `export default { build: { manifest: true, server: false } };\n`,
  );

  await build({ root });

  const manifest = await Bun.file(join(root, "dist/manifest.json")).json();
  expect(Object.keys(manifest).sort()).toEqual([
    "about/index.html",
    "index.html",
  ]);
  const entry = manifest["index.html"];
  expect(entry.isEntry).toBe(true);
  expect(await Bun.file(join(root, "dist", entry.file)).exists()).toBe(true);
  expect(entry.css).toHaveLength(1);
  expect(await Bun.file(join(root, "dist", entry.css[0])).exists()).toBe(true);
});
