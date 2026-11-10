// `bun run build`: the package as npm gets it, in dist/.
//
// steambun ships its TypeScript as is: Bun runs it, and the shell's Swift
// is compiled on the user's machine. So the build is a copy of src/ with a
// package.json that points into it, not a bundle.
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const src = join(root, "src");
const dist = join(root, "dist");
const SRC_PREFIX = /"(\.\/)?src\//;
const STRIP_FIELDS = ["devDependencies", "scripts", "workspaces"];
// Files that must never ship: tests, editor and OS litter.
const NEVER = /(\.test\.ts|\.DS_Store|\.swp)$/;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function writeManifest() {
  const manifest: Record<string, unknown> = await Bun.file(
    join(root, "package.json"),
  ).json();
  for (const field of STRIP_FIELDS) delete manifest[field];
  // `bin` paths have no `./`: `npm pkg fix` strips it, and publish drops
  // a bin it has to correct.
  const text = JSON.stringify(manifest, null, 2)
    .replaceAll('"./src/', '"./')
    .replace(/("steambun": )"\.\/cli\.ts"/, '$1"cli.ts"');
  if (SRC_PREFIX.test(text)) fail("package.json still points into src/");
  await writeFile(join(dist, "package.json"), `${text}\n`);
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(src, dist, { recursive: true, filter: (f) => !NEVER.test(f) });
await writeManifest();
await Promise.all(
  ["README.md", "LICENSE"].map((file) =>
    cp(join(root, file), join(dist, file)),
  ),
);
console.log("✓ Build completed");
