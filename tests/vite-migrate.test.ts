import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findConfigFile } from "../src/config/loader";
import { migrate } from "../src/config/migrate";
import { viteConfigToUserConfig } from "../src/config/vite";
import { linkSteambun, tmpRoot } from "./helpers";

describe("viteConfigToUserConfig", () => {
  test("converts the supported keys and warns on everything else", () => {
    const warnings: string[] = [];
    const config = viteConfigToUserConfig(
      {
        server: { port: 3000, host: true, hmr: { overlay: false } },
        build: { outDir: "build", minify: "terser", lib: { entry: "x.ts" } },
        preview: { port: 5000, host: true },
        resolve: {
          alias: [{ find: "@", replacement: "./src" }],
          extensions: [".ts", ".vue"],
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
    expect(config).not.toHaveProperty("preview");
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
    expect(warnings.some((w) => w.includes('"preview"'))).toBe(true);
    expect(warnings.some((w) => w.includes("resolve.extensions"))).toBe(false);
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

  test("a build.target that is not a Bun target is dropped with a warning", () => {
    const warnings: string[] = [];
    const config = viteConfigToUserConfig(
      { build: { target: "esnext", outDir: "out" } },
      (msg) => warnings.push(msg),
    );
    expect(config.build).toEqual({ outDir: "out" });
    expect(warnings.some((w) => w.includes('"build.target"'))).toBe(true);
    expect(
      viteConfigToUserConfig({ build: { target: "node" } }).build?.target,
    ).toBe("node");
  });

  test("define values that are not strings are JSON-stringified", () => {
    const config = viteConfigToUserConfig({
      define: { A: "'x'", B: 1, C: { v: true } },
    });
    expect(config.define).toEqual({ A: "'x'", B: "1", C: '{"v":true}' });
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

    expect(findConfigFile(root)?.kind).toBe("steambun");
  });

  test("migrates a vite.config.ts that sits next to a bunfig.toml", async () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-migrate-bunfig-"));
    writeFileSync(join(root, "bunfig.toml"), "[install]\nexact = true\n");
    writeFileSync(
      join(root, "vite.config.ts"),
      "export default ({ command }) => ({ server: { port: command === 'build' ? 1 : 2 } });\n",
    );

    await migrate(root);

    expect(readFileSync(join(root, "steambun.config.ts"), "utf8")).toContain(
      "port: 1",
    );
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

  test("inlines a proxy.rewrite function and warns about it", async () => {
    const root = tmpRoot("migrate-rewrite");
    linkSteambun(root);
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

    const logs: string[] = [];
    const log = spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg));
    });
    try {
      await migrate(root);
    } finally {
      log.mockRestore();
    }

    const outPath = join(root, "steambun.config.ts");
    const written = readFileSync(outPath, "utf8");
    expect(written).toContain("rewrite: (p) => p.replace(");
    expect(written).toContain(
      '// Inlined functions to review: server.proxy["/api"].rewrite',
    );
    expect(
      logs.some((l) =>
        l.includes('inlined function at server.proxy["/api"].rewrite'),
      ),
    ).toBe(true);

    const mod = (await import(outPath)) as {
      default: {
        server: { proxy: Record<string, { rewrite: (p: string) => string }> };
      };
    };
    expect(mod.default.server.proxy["/api"]!.rewrite("/api/x")).toBe("/x");
  });

  test("lists unsupported keys in an Ignored Vite keys header line", async () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-migrate-ignored-"));
    writeFileSync(
      join(root, "vite.config.ts"),
      `export default {
  css: { modules: {} },
  plugins: [],
  server: { port: 3000 },
};
`,
    );

    await migrate(root);

    const written = readFileSync(join(root, "steambun.config.ts"), "utf8");
    expect(written).toContain("// Ignored Vite keys: css, plugins");
  });

  test("a function-form vite config with matching dev/build output writes a plain object with no divergence warning", async () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-migrate-same-"));
    writeFileSync(
      join(root, "vite.config.ts"),
      `export default () => ({ server: { port: 4000 } });
`,
    );

    const logs: string[] = [];
    const log = spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg));
    });
    try {
      await migrate(root);
    } finally {
      log.mockRestore();
    }

    expect(logs.some((l) => l.includes("returns different values"))).toBe(
      false,
    );
    const written = readFileSync(join(root, "steambun.config.ts"), "utf8");
    expect(written).toContain("port: 4000");
  });

  test("a function-form vite config with differing dev/build output warns and writes the production result", async () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-migrate-diverge-"));
    writeFileSync(
      join(root, "vite.config.ts"),
      `export default ({ command }) => ({
  server: { port: command === "serve" ? 3000 : 4000 },
});
`,
    );

    const logs: string[] = [];
    const log = spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg));
    });
    try {
      await migrate(root);
    } finally {
      log.mockRestore();
    }

    expect(logs.some((l) => l.includes("returns different values"))).toBe(true);
    const written = readFileSync(join(root, "steambun.config.ts"), "utf8");
    expect(written).toContain("port: 4000");
  });
});
