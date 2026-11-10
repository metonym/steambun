// `bun run test:package`: install the packed package in a new app, the
// way a user does, and run the README's quick start against it.
//
// Catches what the repo's own tests can't see: a file left out of the
// package, an export that points nowhere, a path that only works from
// src/, a bin npm would drop.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dist = join(root, "dist");
const dir = mkdtempSync(join(tmpdir(), "steambun-package-"));
// The tarball holds dist/ only: none of these may ship.
const NOT_SHIPPED = /^package\/(src|tests|scripts|examples|docs)\/|\.test\.ts$/;

function ok(command: string, args: string[], cwd: string): string {
  const r = spawnSync(command, args, { cwd, encoding: "utf-8" });
  if (r.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${r.stdout}${r.stderr}`,
    );
  return r.stdout + r.stderr;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function write(at: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(at, name)), { recursive: true });
    writeFileSync(join(at, name), text);
  }
}

try {
  ok("bun", ["run", "build"], root);

  // npm publish drops a field it has to correct, such as a `bin` path
  // with `./`, after only a warning.
  const publish = spawnSync("npm", ["publish", "--dry-run"], {
    cwd: dist,
    encoding: "utf-8",
  });
  assert(
    !publish.stderr.includes("npm warn publish"),
    `npm publish would correct dist/package.json:\n${publish.stderr}`,
  );

  const tarball = join(
    dir,
    ok("npm", ["pack", "--pack-destination", dir, "--silent"], dist).trim(),
  );
  const files = ok("tar", ["-tzf", tarball], dir).trim().split("\n");
  const stray = files.filter((f) => NOT_SHIPPED.test(f));
  assert(stray.length === 0, `the package ships ${stray.join(", ")}`);
  assert(
    files.includes("package/cli.ts") &&
      files.includes("package/native/Sources/main.swift"),
    "the package is missing the CLI or the shell's Swift",
  );

  // Zero dependencies: the package imports Bun and Node builtins, its own
  // files, and svelte/compiler (the Svelte plugin; the user installs it).
  const ALLOWED =
    /^(bun|bun:.+|node:.+|\.{1,2}\/.+|steambun\/.+|svelte\/compiler)$/;
  const imports = new Bun.Glob("**/*.{ts,tsx}").scanSync(dist);
  for (const f of imports) {
    const text = await Bun.file(join(dist, f)).text();
    for (const m of text.matchAll(/(?:from |import\(|import )"([^"]+)"/g)) {
      const spec = m[1];
      assert(
        spec !== undefined && ALLOWED.test(spec),
        `${f} imports ${spec}, which isn't a builtin or the package's own`,
      );
    }
  }

  // The README's quick start: a page, a script, a tsconfig, no config.
  const app = join(dir, "notes");
  write(app, {
    "package.json": JSON.stringify({
      name: "notes",
      private: true,
      type: "module",
    }),
    "tsconfig.json": '{ "extends": "steambun/tsconfig.json" }\n',
    "index.html": `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Notes</title>
    <link rel="stylesheet" href="steambun/native.css" />
  </head>
  <body>
    <h1>Notes</h1>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
`,
    "main.ts": `import { getSetting, loadSettings, setSetting } from "steambun/ui";

await loadSettings();
const h1 = document.querySelector("h1")!;
h1.textContent = getSetting("title") ?? "Notes";
h1.contentEditable = "true";
h1.oninput = () => setSetting("title", h1.textContent ?? "");
`,
    "test/app.e2e.ts": `import { expect } from "bun:test";
import { describeApp, test } from "steambun/test";

describeApp({ ready: "h1" }, (app) => {
  test("the page loads", async () => {
    expect(await app.text("h1")).toBe("Notes");
  });
});
`,
    // Every export resolves and type-checks from outside the repo. Kept
    // out of the page and the core, so steambun check doesn't walk it.
    "exports.ts": `import { defineApp } from "steambun/config";
import { op, t } from "steambun/schema";
import { PAGE_OPS } from "steambun/bridge";
import { serve } from "steambun/core";
import { native } from "steambun/ui";
import { paths } from "steambun/tools";
import { describeApp } from "steambun/test";
import svelte from "steambun/svelte";
import pkg from "steambun/package.json";

export const all = [defineApp, op, t, PAGE_OPS, serve, native, paths, describeApp, svelte, pkg.version];
`,
  });
  ok("bun", ["add", tarball, "svelte@5"], app);
  // `bun init`, which the quick start runs, adds Bun's types.
  ok("bun", ["add", "-d", "@types/bun"], app);

  ok("bunx", ["steambun", "check"], app);
  ok("bun", ["check"], app);
  // Builds the page and the shell from the installed package, then runs
  // the test in the Mac app and in a tab.
  const test = ok("bunx", ["steambun", "test", "--both"], app);
  const passes = [...test.matchAll(/^\s*1 pass$/gm)].length;
  assert(passes === 2, `expected 1 pass on each backend:\n${test}`);

  console.log(
    "✓ The packed package installs, type-checks, and runs its quick start in the Mac app and in a tab",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
