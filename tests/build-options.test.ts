import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../src/build/build";
import {
  createCompiledBuildConfig,
  createHtmlBuildConfig,
  toBunMinify,
} from "../src/build/options";
import { resolveDefaults } from "../src/config/loader";

function ctx(mode: string) {
  return {
    root: tmpdir(),
    command: "build" as const,
    mode,
    configFile: null,
  };
}

describe("toBunMinify", () => {
  test("boolean and esbuild alias map to Bun minify", () => {
    expect(toBunMinify(true)).toBe(true);
    expect(toBunMinify(false)).toBe(false);
    expect(toBunMinify("esbuild")).toBe(true);
    expect(toBunMinify(undefined)).toBe(true);
  });

  test("object form is passed through", () => {
    const minify = { whitespace: true, syntax: true, identifiers: false };
    expect(toBunMinify(minify)).toEqual(minify);
  });

  test("terser maps to true and warns once", () => {
    const warnings: string[] = [];
    const warn = (msg: string) => {
      warnings.push(msg);
    };
    expect(toBunMinify("terser", warn)).toBe(true);
    expect(toBunMinify("terser", warn)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("terser");
  });
});

describe("resolveDefaults drop / standalone", () => {
  test("appType defaults to spa and only mpa is accepted", () => {
    expect(resolveDefaults({}, ctx("production")).appType).toBe("spa");
    expect(resolveDefaults({ appType: "spa" }, ctx("production")).appType).toBe(
      "spa",
    );
    expect(resolveDefaults({ appType: "mpa" }, ctx("production")).appType).toBe(
      "mpa",
    );
  });

  test("invalid appType warns and falls back to spa", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config = resolveDefaults(
        { appType: "custom" as never },
        ctx("production"),
      );
      expect(config.appType).toBe("spa");
      expect(
        warnSpy.mock.calls.some((call) => String(call[0]).includes("custom")),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("envDir defaults to root and resolves relative to root", () => {
    expect(resolveDefaults({}, ctx("production")).envDir).toBe(
      ctx("production").root,
    );
    expect(
      resolveDefaults({ envDir: "config" }, ctx("production")).envDir,
    ).toBe(join(ctx("production").root, "config"));
  });

  test("production default drop is debugger", () => {
    const config = resolveDefaults({}, ctx("production"));
    expect(config.build.drop).toEqual(["debugger"]);
    expect(config.build.standalone).toBe(false);
    expect(config.build.minify).toBe(true);
  });

  test("explicit empty drop disables the default", () => {
    const config = resolveDefaults({ build: { drop: [] } }, ctx("production"));
    expect(config.build.drop).toEqual([]);
  });

  test("custom drop is kept", () => {
    const config = resolveDefaults(
      { build: { drop: ["console", "debugger"] } },
      ctx("production"),
    );
    expect(config.build.drop).toEqual(["console", "debugger"]);
  });

  test("non-production default drop is empty", () => {
    const config = resolveDefaults({}, ctx("development"));
    expect(config.build.drop).toEqual([]);
  });
});

describe("createHtmlBuildConfig", () => {
  test("hashed naming for the default directory output", () => {
    const config = resolveDefaults({}, ctx("production"));
    const opts = createHtmlBuildConfig({
      config,
      entrypoints: [join(config.root, "index.html")],
      define: {},
      plugins: [],
      outDir: join(config.root, "dist"),
    });
    expect(opts.target).toBe("browser");
    expect(opts.minify).toBe(true);
    expect(opts.drop).toEqual(["debugger"]);
    expect(opts.compile).toBeUndefined();
    expect(opts.metafile).toBe(true);
    expect(opts.naming).toEqual({
      entry: "[dir]/[name].[ext]",
      chunk: "assets/[name]-[hash].[ext]",
      asset: "assets/[name]-[hash].[ext]",
    });
    expect(opts.publicPath).toBeUndefined();
    expect(opts.env).toBeUndefined();
    expect(opts.splitting).toBeUndefined();
  });

  test("base becomes publicPath and a single envPrefix becomes env", () => {
    const config = resolveDefaults(
      { base: "/app", envPrefix: "PUBLIC_" },
      ctx("production"),
    );
    const opts = createHtmlBuildConfig({
      config,
      entrypoints: [join(config.root, "index.html")],
      define: {},
      plugins: [],
      outDir: join(config.root, "dist"),
    });
    expect(opts.publicPath).toBe("/app/");
    expect(opts.env).toBe("PUBLIC_*");
  });

  test("resolve.alias prepends a steambun-alias plugin", () => {
    const config = resolveDefaults(
      { resolve: { alias: { "@": "./src" } } },
      ctx("production"),
    );
    const opts = createHtmlBuildConfig({
      config,
      entrypoints: [join(config.root, "index.html")],
      define: {},
      plugins: [],
      outDir: join(config.root, "dist"),
    });
    expect(opts.plugins?.[0]?.name).toBe("steambun-alias");
  });

  test("build.target overrides the HTML default", () => {
    const config = resolveDefaults(
      { build: { target: "bun" } },
      ctx("production"),
    );
    const opts = createHtmlBuildConfig({
      config,
      entrypoints: [join(config.root, "index.html")],
      define: {},
      plugins: [],
      outDir: join(config.root, "dist"),
    });
    expect(opts.target).toBe("bun");
  });

  test("cssChunking passes through; minChunkSize only applies with splitting", () => {
    const config = resolveDefaults(
      { build: { cssChunking: true, minChunkSize: 5000 } },
      ctx("production"),
    );
    const opts = createHtmlBuildConfig({
      config,
      entrypoints: [join(config.root, "index.html")],
      define: {},
      plugins: [],
      outDir: join(config.root, "dist"),
    });
    expect(opts.cssChunking).toBe(true);
    expect(opts.minChunkSize).toBeUndefined();

    const splittingConfig = resolveDefaults(
      { build: { splitting: true, minChunkSize: 5000 } },
      ctx("production"),
    );
    const splittingOpts = createHtmlBuildConfig({
      config: splittingConfig,
      entrypoints: [join(splittingConfig.root, "index.html")],
      define: {},
      plugins: [],
      outDir: join(splittingConfig.root, "dist"),
    });
    expect(splittingOpts.splitting).toBe(true);
    expect(splittingOpts.minChunkSize).toBe(5000);
  });

  test("features forwards config.features and merges STEAMBUN_FEATURES", () => {
    const prevEnv = process.env.STEAMBUN_FEATURES;
    try {
      delete process.env.STEAMBUN_FEATURES;
      const config = resolveDefaults({ features: ["a"] }, ctx("production"));
      const opts = createHtmlBuildConfig({
        config,
        entrypoints: [join(config.root, "index.html")],
        define: {},
        plugins: [],
        outDir: join(config.root, "dist"),
      });
      expect(opts.features).toEqual(["a"]);

      process.env.STEAMBUN_FEATURES = "b, c";
      const merged = createHtmlBuildConfig({
        config,
        entrypoints: [join(config.root, "index.html")],
        define: {},
        plugins: [],
        outDir: join(config.root, "dist"),
      });
      expect(merged.features).toEqual(["a", "b", "c"]);

      const noFeaturesConfig = resolveDefaults({}, ctx("production"));
      delete process.env.STEAMBUN_FEATURES;
      const noFeatures = createHtmlBuildConfig({
        config: noFeaturesConfig,
        entrypoints: [join(noFeaturesConfig.root, "index.html")],
        define: {},
        plugins: [],
        outDir: join(noFeaturesConfig.root, "dist"),
      });
      expect(noFeatures.features).toBeUndefined();
    } finally {
      if (prevEnv === undefined) delete process.env.STEAMBUN_FEATURES;
      else process.env.STEAMBUN_FEATURES = prevEnv;
    }
  });

  test("standalone uses compile + browser and skips hashed naming", () => {
    const config = resolveDefaults(
      { build: { standalone: true, minify: "esbuild" } },
      ctx("production"),
    );
    const opts = createHtmlBuildConfig({
      config,
      entrypoints: [join(config.root, "index.html")],
      define: {},
      plugins: [],
      outDir: join(config.root, "dist"),
    });
    expect(opts.compile).toBe(true);
    expect(opts.target).toBe("browser");
    expect(opts.naming).toBeUndefined();
    expect(opts.metafile).toBe(false);
    expect(opts.minify).toBe(true);
  });

  test("build.splitting is passed through for directory output", () => {
    const config = resolveDefaults(
      { build: { splitting: true } },
      ctx("production"),
    );
    const opts = createHtmlBuildConfig({
      config,
      entrypoints: [join(config.root, "index.html")],
      define: {},
      plugins: [],
      outDir: join(config.root, "dist"),
    });
    expect(opts.splitting).toBe(true);
  });

  test("standalone ignores build.splitting", () => {
    const config = resolveDefaults(
      { build: { standalone: true, splitting: true } },
      ctx("production"),
    );
    const opts = createHtmlBuildConfig({
      config,
      entrypoints: [join(config.root, "index.html")],
      define: {},
      plugins: [],
      outDir: join(config.root, "dist"),
    });
    expect(opts.compile).toBe(true);
    expect(opts.splitting).toBeUndefined();
  });
});

describe("createCompiledBuildConfig", () => {
  test("passes minify, drop, and define through to the bun target", () => {
    const config = resolveDefaults(
      { compile: true, build: { minify: true } },
      ctx("production"),
    );
    const define = { "process.env.NODE_ENV": '"production"' };
    const opts = createCompiledBuildConfig({
      config,
      prodServePath: "/tmp/prod-serve.ts",
      define,
      plugins: [],
      outfile: "/tmp/bin/server",
      assets: ["/tmp/dist"],
    });
    expect(opts.target).toBe("bun");
    expect(opts.minify).toBe(true);
    expect(opts.drop).toEqual(["debugger"]);
    expect(opts.define).toEqual(define);
    expect(opts.compile).toEqual({
      outfile: "/tmp/bin/server",
      assets: ["/tmp/dist"],
      autoloadDotenv: false,
    });
    expect(opts.bytecode).toBeUndefined();
    expect(opts.splitting).toBeUndefined();
  });

  test("bytecode is passed only when requested", () => {
    const config = resolveDefaults(
      { compile: true, build: { bytecode: true } },
      ctx("production"),
    );
    const opts = createCompiledBuildConfig({
      config,
      prodServePath: "/tmp/prod-serve.ts",
      define: {},
      plugins: [],
      outfile: "/tmp/bin/server",
      assets: ["/tmp/dist"],
    });
    expect(opts.bytecode).toBe(true);
  });

  test("compileTarget sets compile.target; windows and autoloadBunfig forward", () => {
    const config = resolveDefaults(
      {
        compile: {
          targets: ["bun-linux-x64"],
          autoloadBunfig: false,
          windows: { title: "My App", hideConsole: true },
        },
      },
      ctx("production"),
    );
    const opts = createCompiledBuildConfig({
      config,
      prodServePath: "/tmp/prod-serve.ts",
      define: {},
      plugins: [],
      outfile: "/tmp/bin/server-bun-linux-x64",
      assets: ["/tmp/dist"],
      compileTarget: "bun-linux-x64",
    });
    const compile = opts.compile as Record<string, unknown>;
    expect(compile.target).toBe("bun-linux-x64");
    expect(compile.autoloadBunfig).toBe(false);
    expect(compile.windows).toEqual({ title: "My App", hideConsole: true });
  });
});

describe("compile option normalization", () => {
  test("true becomes {}, an object stays as-is, false and undefined pass through", () => {
    expect(
      resolveDefaults({ compile: true }, ctx("production")).compile,
    ).toEqual({});
    expect(
      resolveDefaults(
        { compile: { targets: ["bun-linux-x64"] } },
        ctx("production"),
      ).compile,
    ).toEqual({ targets: ["bun-linux-x64"] });
    expect(resolveDefaults({ compile: false }, ctx("production")).compile).toBe(
      false,
    );
    expect(resolveDefaults({}, ctx("production")).compile).toBeUndefined();
  });
});

describe("standalone HTML build", () => {
  test("inlines JS and CSS into a single html file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-standalone-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "index.html"),
      `<!doctype html>
<html>
  <head>
    <link rel="stylesheet" href="./src/style.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="./src/main.ts"></script>
  </body>
</html>
`,
    );
    writeFileSync(
      join(dir, "src", "main.ts"),
      `document.getElementById("app")!.textContent = "hello-standalone";\n`,
    );
    writeFileSync(join(dir, "src", "style.css"), `body { color: #abc123; }\n`);
    writeFileSync(
      join(dir, "steambun.config.ts"),
      `export default { build: { standalone: true, minify: false } };\n`,
    );

    await build({ root: dir });

    const dist = join(dir, "dist");
    const files = readdirSync(dist);
    expect(files.filter((f) => f.endsWith(".html"))).toEqual(["index.html"]);
    expect(files.some((f) => f.endsWith(".css"))).toBe(false);
    expect(files.some((f) => f.endsWith(".js"))).toBe(false);

    const html = await Bun.file(join(dist, "index.html")).text();
    expect(html).toContain("hello-standalone");
    expect(html).toContain("#abc123");
    expect(html).toContain("<style");
    expect(html).toContain("<script");
  });

  test("minifies the HTML shell when minify is on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-standalone-min-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "index.html"),
      `<!doctype html>
<html>
  <head>
    <link rel="stylesheet" href="./src/style.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="./src/main.ts"></script>
  </body>
</html>
`,
    );
    writeFileSync(
      join(dir, "src", "main.ts"),
      `document.getElementById("app")!.textContent = "hello-standalone";\n`,
    );
    writeFileSync(join(dir, "src", "style.css"), `body { color: #abc123; }\n`);
    writeFileSync(
      join(dir, "steambun.config.ts"),
      `export default { build: { standalone: true, minify: true } };\n`,
    );

    await build({ root: dir });

    const html = await Bun.file(join(dir, "dist", "index.html")).text();
    expect(html).toContain("hello-standalone");
    expect(html).toContain("<style");
    expect(html).not.toContain("\n  <");
    expect(html).toContain("<!doctype html><html>");
  });
});

describe("build.features", () => {
  test("build() eliminates the dead branch for an enabled feature flag", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-features-"));
    writeFileSync(
      join(dir, "index.html"),
      `<!doctype html><html><body><script type="module" src="./main.ts"></script></body></html>\n`,
    );
    writeFileSync(
      join(dir, "main.ts"),
      `import { feature } from "bun:bundle";
if (feature("myflag")) {
  console.log("FLAG_ON_BRANCH");
} else {
  console.log("FLAG_OFF_BRANCH");
}
`,
    );
    writeFileSync(
      join(dir, "steambun.config.ts"),
      `export default { features: ["myflag"], build: { server: false } };\n`,
    );

    await build({ root: dir });

    const jsFile = readdirSync(join(dir, "dist", "assets")).find((f) =>
      f.endsWith(".js"),
    );
    const output = await Bun.file(join(dir, "dist", "assets", jsFile!)).text();
    expect(output).toContain("FLAG_ON_BRANCH");
    expect(output).not.toContain("FLAG_OFF_BRANCH");
  });
});
