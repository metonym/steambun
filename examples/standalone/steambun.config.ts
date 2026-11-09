import { defineConfig } from "steambun";

export default defineConfig({
  server: {
    port: 5178,
  },
  build: {
    standalone: true,
  },
});
