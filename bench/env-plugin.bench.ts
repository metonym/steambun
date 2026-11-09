import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { group, task } from "ostia";
import { createDevTransformPlugin } from "../src/dev/env-plugin";
import { buildBundleDefine } from "../src/env/loader";

// A real dev session's shape: 20 VITE_* vars plus the builtin import.meta.env.* fields.
const env = Object.fromEntries(
  Array.from({ length: 20 }, (_, i) => [`VITE_VAR_${i}`, `v${i}`]),
);
const defines = buildBundleDefine(
  env,
  { mode: "development", command: "dev", base: "/" },
  { __APP_VERSION__: '"1"' },
);

const dir = mkdtempSync(join(tmpdir(), "steambun-envplugin-"));

let body = "";
for (let i = 0; i < 1200; i++) {
  body += `// c${i}\nexport function f${i}(a: number, b: string) {\n  const s = \`t \${a} \${b}\`;\n  if (a > ${i}) return s + "l'${i}" + '${i}';\n  return { k: a * ${i}, s };\n}\n`;
}
writeFileSync(join(dir, "nokey.ts"), body);
writeFileSync(
  join(dir, "key.ts"),
  `${body}\nconsole.log(import.meta.env.MODE, __APP_VERSION__);\n`,
);

let onLoad!: (args: { path: string }) => unknown;
createDevTransformPlugin(defines, { root: dir }).setup({
  onLoad: (_filter: unknown, cb: typeof onLoad) => {
    onLoad = cb;
  },
} as import("bun").PluginBuilder);

group("dev/env-plugin: onLoad (200 KB module)", () => {
  task("no define key present (early exit)", () =>
    onLoad({ path: join(dir, "nokey.ts") }),
  );
  task("one define key present (full scan)", () =>
    onLoad({ path: join(dir, "key.ts") }),
  );
});
