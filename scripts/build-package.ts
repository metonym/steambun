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

// exports/bin are already correct in the source package.json; only
// the dev-only fields need stripping.
delete pkg.scripts;
delete pkg.devDependencies;
delete pkg.workspaces;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

writeFileSync(
  join(outDir, "package.json"),
  `${JSON.stringify(pkg, null, 2)}\n`,
);

for (const name of ["README.md", "LICENSE", "src", "bin"]) {
  const from = join(root, name);
  if (existsSync(from)) {
    cpSync(from, join(outDir, name), { recursive: true });
  }
}

console.log(`built package/ → ${pkg.name}@${pkg.version}`);
