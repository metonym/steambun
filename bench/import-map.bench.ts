import { group, task } from "ostia";
import { rewriteChunkSource } from "../src/build/import-map";

// A ~400 KB minified-ish chunk: many `ident("literal")` calls, which is what
// the helper-token global regex has to walk even when no preload helper exists.
let body = "";
for (let i = 0; i < 4000; i++) {
  body += `function f${i}(a,b){return t("k${i}")+a*b+${i}}\n`;
}
const noHelper = `import"./vendor-aaaaaaaa.js";${body}`;
const withHelper = `${noHelper}\n__preload(import.meta.url,["deadbeef","cafe1234"]);\n`;

const stable = new Map<string, string>([
  ["assets/entry-11111111.js", "id-entry"],
  ["assets/vendor-aaaaaaaa.js", "id-vendor"],
]);
const tokens = new Map<string, string>([
  ["aaaaaaaa", "id-vendor"],
  ["deadbeef", "id-a"],
  ["cafe1234", "id-b"],
]);
const ctx = {
  rel: "assets/entry-11111111.js",
  outDir: "/tmp/dist",
  base: "/",
  stable,
  tokens,
};

group("build/import-map: rewriteChunkSource (400 KB chunk)", () => {
  task("chunk without a preload helper", () =>
    rewriteChunkSource(noHelper, ctx),
  );
  task("chunk with a preload helper table", () =>
    rewriteChunkSource(withHelper, ctx),
  );
});
