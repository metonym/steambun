import { group, task } from "ostia";
import { resolveDefaults } from "../src/config/loader";
import type { UserConfig } from "../src/config/types";

const ctx = {
  root: "/project",
  command: "dev" as const,
  mode: "development",
  configFile: "/project/steambun.config.ts",
};

const empty: UserConfig = {};

const realistic: UserConfig = {
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:4000", changeOrigin: true },
      "/legacy": "http://localhost:8080",
    },
  },
  build: { outDir: "dist", manifest: true, sourcemap: "inline" },
  api: "./src/api",
  envPrefix: ["VITE_", "PUBLIC_", "APP_"],
  plugins: [{ name: "noop", setup() {} }],
};

group("config/loader: resolveDefaults (startup path)", () => {
  task("empty user config", () => resolveDefaults(empty, ctx));

  task("realistic user config (proxy, api, plugins)", () =>
    resolveDefaults(realistic, ctx),
  );
});
