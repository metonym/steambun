import { defineConfig } from "steambun";

export default defineConfig({
  server: {
    port: 5178,
  },
  build: {
    // src/nav.ts is shared by all three pages; splitting makes it its own
    // hashed chunk that every page imports.
    splitting: true,
  },
});
