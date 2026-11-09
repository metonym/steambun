import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { group, task } from "ostia";
import { transformImportGlobs } from "../src/util/import-glob";

// Runs on every client module, so the no-glob fast path matters most.
const root = mkdtempSync(join(tmpdir(), "steambun-glob-bench-"));
mkdirSync(join(root, "src/pages"), { recursive: true });
for (let i = 0; i < 50; i++) {
  writeFileSync(join(root, `src/pages/p${i}.ts`), `export default ${i};\n`);
}

let body = "";
for (let i = 0; i < 1200; i++) {
  body += `// c${i}\nexport function f${i}(a: number, b: string) {\n  const s = \`t \${a} \${b}\`;\n  if (a > ${i}) return s + "l'${i}" + '${i}';\n  return { k: a * ${i}, s };\n}\n`;
}
const withGlob = `${body}\nexport const pages = import.meta.glob("./pages/*.ts", { eager: true, import: "default" });\n`;
const ctx = { importer: join(root, "src/main.ts"), root };

group(
  "util/import-glob: transformImportGlobs (200 KB module)",
  () => {
    task("no import.meta.glob (fast path)", () =>
      transformImportGlobs(body, ctx),
    );
    task("one eager glob over 50 files", () =>
      transformImportGlobs(withGlob, ctx),
    );
  },
  { alloc: true },
);
