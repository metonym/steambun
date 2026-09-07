import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findConfigFile } from "../src/config/loader";
import { migrate } from "../src/config/migrate";
import { viteConfigToUserConfig } from "../src/config/vite";
import { createViteSuffixPlugin } from "../src/util/vite-suffix-plugin";

// Importing a generated config's `steambun` import resolves via Node/Bun's
// package self-reference, which only works for importers inside this
// package's own directory tree — not from the system tmpdir other tests use.
function tmpMigrateRootWithSelfReference(prefix: string): string {
  const base = join(process.cwd(), ".steambun", "test-tmp");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

describe("viteConfigToUserConfig", () => {
  test("converts the supported keys and warns on everything else", () => {
    const warnings: string[] = [];
    const config = viteConfigToUserConfig(
      {
        server: { port: 3000, host: true, hmr: { overlay: false } },
        build: { outDir: "build", minify: true, lib: { entry: "x.ts" } },
        resolve: {
          alias: [{ find: "@", replacement: "./src" }],
          dedupe: ["react"],
        },
        define: { __VERSION__: '"1.0"' },
        envPrefix: "PUBLIC_",
        envDir: "config",
        base: "/app/",
        publicDir: "static",
        appType: "mpa",
        plugins: [{ name: "vite-plugin-x" }],
        css: { modules: {} },
      },
      (msg) => warnings.push(msg),
    );

    expect(config.server).toEqual({ port: 3000, host: true });
    expect(config.build).toEqual({ outDir: "build", minify: true });
    expect(config.resolve).toEqual({ alias: { "@": "./src" } });
    expect(config.define).toEqual({ __VERSION__: '"1.0"' });
    expect(config.envPrefix).toBe("PUBLIC_");
    expect(config.envDir).toBe("config");
    expect(config.base).toBe("/app/");
    expect(config.publicDir).toBe("static");
    expect(config.appType).toBe("mpa");
    expect(config.plugins).toBeUndefined();

    expect(warnings.some((w) => w.includes('"css"'))).toBe(true);
    expect(warnings.some((w) => w.includes('"server.hmr"'))).toBe(true);
    expect(warnings.some((w) => w.includes('"build.lib"'))).toBe(true);
    expect(warnings.some((w) => w.includes('"resolve.dedupe"'))).toBe(true);
    expect(
      warnings.some(
        (w) => w === "[steambun] Vite plugins are ignored; use Bun plugins.",
      ),
    ).toBe(true);
  });

  test("object-form resolve.alias converts directly", () => {
    const config = viteConfigToUserConfig(
      { resolve: { alias: { "@": "/src", "~": "/lib" } } },
      () => {},
    );
    expect(config.resolve?.alias).toEqual({ "@": "/src", "~": "/lib" });
  });

  test("an unrecognized appType value warns instead of converting", () => {
    const warnings: string[] = [];
    const config = viteConfigToUserConfig({ appType: "custom" }, (msg) =>
      warnings.push(msg),
    );
    expect(config.appType).toBeUndefined();
    expect(warnings.some((w) => w.includes("appType"))).toBe(true);
  });
});

describe("migrate", () => {
  test("writes steambun.config.ts converted from vite.config.ts", async () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-migrate-"));
    writeFileSync(
      join(root, "vite.config.ts"),
      `export default {
  server: { port: 4000 },
  build: { outDir: "out" },
};
`,
    );

    await migrate(root);

    const written = readFileSync(join(root, "steambun.config.ts"), "utf8");
    expect(written).toContain('import { defineConfig } from "steambun"');
    expect(written).toContain("port: 4000");
    expect(written).toContain('outDir: "out"');

    // Re-running finds the newly-written steambun config, not vite's.
    expect(findConfigFile(root)?.kind).toBe("steambun");
  });

  test("never overwrites an existing steambun config", async () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-migrate-existing-"));
    writeFileSync(join(root, "vite.config.ts"), "export default {};\n");
    writeFileSync(
      join(root, "steambun.config.ts"),
      "export default { server: { port: 1 } };\n",
    );

    await expect(migrate(root)).rejects.toThrow(/already exists/);
  });

  test("throws when there is no vite.config.* to migrate", async () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-migrate-none-"));
    await expect(migrate(root)).rejects.toThrow(/No vite.config/);
  });

  test("inlines a proxy.rewrite function instead of dropping it", async () => {
    const root = tmpMigrateRootWithSelfReference("steambun-migrate-rewrite-");
    writeFileSync(
      join(root, "vite.config.ts"),
      `export default {
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        rewrite: (p) => p.replace(/^\\/api/, ""),
      },
    },
  },
};
`,
    );

    await migrate(root);

    const outPath = join(root, "steambun.config.ts");
    const written = readFileSync(outPath, "utf8");
    expect(written).toContain("rewrite: (p) => p.replace(");

    const mod = (await import(outPath)) as {
      default: {
        server: { proxy: Record<string, { rewrite: (p: string) => string }> };
      };
    };
    expect(mod.default.server.proxy["/api"]!.rewrite("/api/x")).toBe("/x");
  });
});

describe("createViteSuffixPlugin", () => {
  test("?raw, ?url, and ?inline each resolve through a real build", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-vite-suffix-"));
    writeFileSync(join(dir, "data.txt"), "hello suffixes");
    writeFileSync(
      join(dir, "entry.ts"),
      `import raw from "./data.txt?raw";
import url from "./data.txt?url";
import inline from "./data.txt?inline";
export { raw, url, inline };
`,
    );

    const result = await Bun.build({
      entrypoints: [join(dir, "entry.ts")],
      outdir: join(dir, "dist"),
      target: "bun",
      plugins: [createViteSuffixPlugin()],
    });
    expect(result.success).toBe(true);

    const mod = (await import(result.outputs[0]!.path)) as {
      raw: string;
      url: string;
      inline: string;
    };
    expect(mod.raw).toBe("hello suffixes");
    expect(mod.url).toContain("data");
    expect(mod.inline.startsWith("data:")).toBe(true);
    expect(atob(mod.inline.split("base64,")[1]!)).toBe("hello suffixes");
  });
});
