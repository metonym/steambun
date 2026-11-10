import { defineConfig } from "bivium";

export default defineConfig({
  suites: {
    unit: {
      tests: "tests/*.test.ts",
      run: "bun test {files}",
      root: "tests",
      // `bun test` runs the code: an `import type` can't change what it does.
      types: false,
    },
    // Each example's tests build and launch that whole app, in the Mac app
    // and in a tab.
    examples: {
      tests: "examples/*/test/*.e2e.ts",
      root: "examples",
      types: false,
      // The examples' guide: no test reads it.
      nonInputs: ["examples/README.md"],
    },
    package: {
      tests: "scripts/test-package.ts",
      root: "scripts/test-package.ts",
    },
  },
  roots: [
    "src",
    "tests",
    "examples",
    "scripts",
    "package.json",
    "tsconfig.json",
    "bunfig.toml",
  ],
  // Docs, and config for tools and workflows that run none of these suites.
  ignore: [
    "*.md",
    "docs/**",
    "LICENSE",
    ".gitignore",
    "knip.json",
    ".github/workflows/release.yml",
    // Benchmarks: run by hand, not by any suite.
    "bench/**",
    "ostia.config.ts",
  ],
  edges: {
    // A test launches its whole app: config, page, core, Swift and assets.
    "examples/*/test/*.e2e.ts": ["examples/$1/**", "src/cli.ts"],
    // The page links the stylesheet by package path; Bun's HTML bundler
    // resolves it to the package's file.
    "examples/*/steambun/native.css": "src/ui/native.css",
    // The CLI builds the Swift shell and spawns the dev page from disk.
    "src/tools.ts": ["src/native/**", "src/devpage.ts", "src/bridge.ts"],
    // Builds and packs the package, then runs a new app on it.
    "scripts/test-package.ts": "scripts/build.ts",
    // Runs its fixture as a separate `bun test`.
    "tests/timeout.test.ts": "tests/fixtures/slow.fixture.ts",
    "scripts/build.ts": ["src/**", "package.json"],
  },
  reads: {
    // Builds two examples' pages as static sites.
    "tests/web.test.ts": ["examples/hello/**", "examples/core/**"],
    // Runs the CLI in an example, and builds it.
    "tests/cli.test.ts": ["examples/hello/**"],
  },
  // steambun reads and runs its user's app: its config, page, core and
  // build output. The tests read only the temp folders they write.
  hermetic: [
    "src/**",
    "tests/check.test.ts",
    "tests/config.test.ts",
    "tests/host.test.ts",
  ],
  inert: ["knip", "@types/*"],
});
