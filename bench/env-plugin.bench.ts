import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { group, task } from "ostia";
import { generateEnvPluginSource } from "../src/dev/env-plugin";
import { buildBundleDefine } from "../src/env/loader";

// Same shape as a real dev session: 20 VITE_* vars plus the builtin
// import.meta.env.* fields buildBundleDefine always adds.
const env = Object.fromEntries(
  Array.from({ length: 20 }, (_, i) => [`VITE_VAR_${i}`, `v${i}`]),
);
const defines = buildBundleDefine(
  env,
  { mode: "development", command: "dev", base: "/" },
  { __APP_VERSION__: '"1"' },
);

// Write the generated plugin into a fresh mkdtemp dir: Bun's resolver caches
// directory listings per process, so importing from a directory that already
// existed before this file's own module resolution can return a stale
// listing for anything written into it afterward.
const dir = mkdtempSync(join(tmpdir(), "steambun-envplugin-"));
// The shipped dev plugin also expands import.meta.glob; point its
// "steambun/runtime" import at this checkout's source so the bench measures
// the working tree, not an installed copy.
writeFileSync(
  join(dir, "env-plugin.ts"),
  generateEnvPluginSource(defines, { root: dir }).replace(
    '"steambun/runtime"',
    JSON.stringify(join(import.meta.dir, "../src/runtime/index.ts")),
  ),
);

let body = "";
for (let i = 0; i < 1200; i++) {
  body += `// c${i}\nexport function f${i}(a: number, b: string) {\n  const s = \`t \${a} \${b}\`;\n  if (a > ${i}) return s + "l'${i}" + '${i}';\n  return { k: a * ${i}, s };\n}\n`;
}
writeFileSync(join(dir, "nokey.ts"), body);
writeFileSync(
  join(dir, "key.ts"),
  `${body}\nconsole.log(import.meta.env.MODE, __APP_VERSION__);\n`,
);

const plugin = (await import(join(dir, "env-plugin.ts"))).default;
let onLoad!: (args: { path: string }) => unknown;
plugin.setup({
  onLoad: (_filter: unknown, cb: typeof onLoad) => {
    onLoad = cb;
  },
});

group("dev/env-plugin: generated onLoad (200 KB module)", () => {
  task("no define key present (early exit)", () =>
    onLoad({ path: join(dir, "nokey.ts") }),
  );
  task("one define key present (full scan)", () =>
    onLoad({ path: join(dir, "key.ts") }),
  );
});
