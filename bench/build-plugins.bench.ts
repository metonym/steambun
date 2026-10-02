import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { group, task } from "ostia";
import { createHtmlBuildConfig } from "../src/build/options";
import { resolveDefaults } from "../src/config/loader";

// Bundles 400 modules with and without the client plugins to isolate their per-file hop.
const MODULES = 400;
const root = mkdtempSync(join(tmpdir(), "steambun-build-bench-"));
mkdirSync(join(root, "src/mods"), { recursive: true });
for (let i = 0; i < MODULES; i++) {
  const next =
    i + 1 < MODULES ? `import { f${i + 1} } from "./m${i + 1}";\n` : "";
  const call = i + 1 < MODULES ? ` + f${i + 1}(a)` : "";
  writeFileSync(
    join(root, `src/mods/m${i}.ts`),
    `${next}export function f${i}(a: number): number {\n  const s = \`${"x".repeat(200)}\`;\n  return a * ${i} + s.length${call};\n}\n`,
  );
}
writeFileSync(
  join(root, "src/main.ts"),
  'import { f0 } from "./mods/m0";\nconsole.log(f0(1));\n',
);
writeFileSync(
  join(root, "index.html"),
  '<!doctype html><html><body><script type="module" src="./src/main.ts"></script></body></html>',
);

const config = resolveDefaults(
  { build: { minify: false } },
  { root, command: "build", mode: "production", configFile: null },
);
const buildConfig = createHtmlBuildConfig({
  config,
  entrypoints: [join(root, "index.html")],
  define: {},
  plugins: [],
  outDir: join(root, "dist"),
});

group(`build/options: Bun.build over ${MODULES} modules`, () => {
  task("steambun client plugins", () => Bun.build(buildConfig));
  task("no plugins (Bun alone)", () =>
    Bun.build({ ...buildConfig, plugins: [] }),
  );
});
