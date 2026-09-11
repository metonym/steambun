import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const outDir = join(root, "package");

const pkg = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
) as Record<string, unknown>;

// exports are already correct in the source package.json; only the
// dev-only fields need stripping. bin/files point at the published
// layout (bin/steambun.ts), which differs from the source layout
// (src/bin.ts) used for local dev.
delete pkg.scripts;
delete pkg.devDependencies;
delete pkg.workspaces;
pkg.bin = { steambun: "bin/steambun.ts" };
pkg.files = ["src", "bin"];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

writeFileSync(
  join(outDir, "package.json"),
  `${JSON.stringify(pkg, null, 2)}\n`,
);

for (const name of ["README.md", "LICENSE", "src"]) {
  const from = join(root, name);
  if (existsSync(from)) {
    cpSync(from, join(outDir, name), { recursive: true });
  }
}

mkdirSync(join(outDir, "bin"), { recursive: true });
const binSrc = readFileSync(join(root, "src", "bin.ts"), "utf8");
writeFileSync(
  join(outDir, "bin", "steambun.ts"),
  binSrc.replace('"./cli"', '"../src/cli"'),
);

console.log(`built package/ → ${pkg.name}@${pkg.version}`);
