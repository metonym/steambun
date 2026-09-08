import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

export interface InitOptions {
  dir?: string;
  force?: boolean;
  cwd?: string;
}

const GITIGNORE = ["node_modules/", "dist/", "bin/", ".steambun/", ""].join(
  "\n",
);

const TSCONFIG = {
  compilerOptions: {
    target: "ESNext",
    module: "ESNext",
    moduleResolution: "bundler",
    lib: ["ESNext", "DOM"],
    types: ["@types/bun"],
    strict: true,
    skipLibCheck: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    allowJs: true,
    noEmit: true,
    allowImportingTsExtensions: true,
  },
  exclude: ["node_modules", "dist"],
};

/** Lowercases, collapses runs of non-`[a-z0-9._-]` into `-`, trims edges. */
function sanitizePackageName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return sanitized || "steambun-app";
}

export async function init(opts: InitOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const targetDir = resolve(cwd, opts.dir ?? ".");

  await mkdir(targetDir, { recursive: true });

  const existing = await readdir(targetDir);
  if (existing.length > 0 && !opts.force) {
    throw new Error(
      `[steambun] ${targetDir} is not empty — use --force, or pick an empty directory.`,
    );
  }

  const name = sanitizePackageName(basename(targetDir));

  const templateDir = join(import.meta.dir, "..", "templates", "minimal");
  await cp(templateDir, targetDir, { recursive: true });

  const pkgPath = join(targetDir, "package.json");
  const pkg = JSON.parse(await Bun.file(pkgPath).text()) as {
    name: string;
    devDependencies: Record<string, string>;
    [key: string]: unknown;
  };
  const ownPkg = JSON.parse(
    await Bun.file(join(import.meta.dir, "..", "package.json")).text(),
  ) as { version: string };
  pkg.name = name;
  pkg.devDependencies.steambun = `^${ownPkg.version}`;
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  await writeFile(join(targetDir, ".gitignore"), GITIGNORE);
  await writeFile(
    join(targetDir, "tsconfig.json"),
    `${JSON.stringify(TSCONFIG, null, 2)}\n`,
  );

  const relDir = relative(cwd, targetDir);
  console.log(`[steambun] created ${targetDir}`);
  console.log("\nNext steps:");
  if (relDir) console.log(`  cd ${relDir}`);
  console.log("  bun install");
  console.log("  bun run dev");
  console.log(
    "\nRun `steambun doctor` after installing to check for config issues.",
  );
}
