import { defineConfig } from "steambun";

export default defineConfig({
  server: {
    port: 5178,
  },
  build: {
    // src/nav.ts is shared by all three pages. Without splitting, each
    // page's whole bundle is one file; with it, nav.ts becomes its own
    // hashed chunk that every page imports.
    splitting: true,
    // Bun's split chunks import each other by hashed filename, so editing
    // nav.ts would otherwise change every page's own hash too (it imports
    // the renamed file). importMap routes chunk-to-chunk imports through a
    // content-independent id instead, so only nav's own chunk re-hashes.
    importMap: true,
    // src/shared.css is pulled into every page's CSS output verbatim (Bun
    // copies it into each page's stylesheet rather than sharing one file).
    // sharedCss cuts that duplicated block out into its own file, so
    // editing it only invalidates one shared stylesheet instead of three.
    // minSize (minified bytes, default 2048) is lowered here so this small
    // example stylesheet is still worth extracting.
    sharedCss: { minSize: 100 },
  },
});
