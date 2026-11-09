// The build side of steambun. Everything reads steambun.config.ts at the
// app's root; `steambun <command>` (cli.ts) is a thin wrapper over these.
//
//   gen     the shell's generated Swift: Bridge.gen.swift (the framework's
//           ops), App.gen.swift (the app's ops) and Config.gen.swift
//   build   the page (build/page), or with a core, one AOT binary with
//           the page inside (build/core)
//   app     the .app: the Swift shell, Info.plist, the page or the core,
//           signed
//   dev     the page (or the core) from source under `bun --hot`, in a
//           tab or the shell
import { $ } from "bun";
import { check, pageEntries, report } from "./check.ts";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { BunPlugin } from "bun";
import type { Resolved } from "./config.ts";
import { configSwift, coreScript, infoPlist } from "./gen/config.ts";
import { appSwift, frameworkSwift } from "./gen/bridge.ts";
import type { Bridge } from "./schema.ts";

const FW = import.meta.dir;
const NATIVE = join(FW, "native");
const rel = (c: Resolved, p: string) => join(c.root, p);
const say = (m: string) => console.error(`steambun: ${m}`);

/** Where the built pieces go. */
export const paths = (c: Resolved) => ({
  app: rel(c, `${c.out}/${c.name}.app`),
  shell: rel(c, `${c.out}/${c.name}.app/Contents/MacOS/${c.name}`),
  gen: rel(c, `${c.out}/gen`),
  /** The compiled core. */
  core: rel(c, `${c.out}/core/${c.name}`),
  /** The built page, for an app with no core. */
  page: rel(c, `${c.out}/page`),
  /** The page as a static site: `steambun build --web`. */
  web: rel(c, `${c.out}/web`),
  /** The core's JS, for `bun: "system"`. */
  script: rel(c, `${c.out}/core`),
});

// MARK: gen

/**
 * Write the generated Swift. With `check`, write nothing: return false if
 * the committed framework file is stale. The app's files are build output.
 */
export async function gen(c: Resolved, check = false): Promise<boolean> {
  const out: [string, string][] = [
    [join(NATIVE, "Sources/Bridge.gen.swift"), frameworkSwift()],
  ];
  if (!check) {
    const app = c.bridge
      ? ((await import(rel(c, c.bridge))).default as Bridge)
      : null;
    out.push(
      [
        join(paths(c).gen, "App.gen.swift"),
        appSwift(app, c.bridge ?? "(no bridge)"),
      ],
      [
        join(paths(c).gen, "Config.gen.swift"),
        configSwift(c, "steambun.config.ts"),
      ],
    );
  }
  let ok = true;
  for (const [path, text] of out) {
    if (!check) {
      // Unchanged files keep their mtime, so a watcher doesn't fire.
      if (
        (await Bun.file(path)
          .text()
          .catch(() => "")) !== text
      )
        await Bun.write(path, text);
    } else if (
      (await Bun.file(path)
        .text()
        .catch(() => "")) !== text
    ) {
      say(`${path} is stale: run steambun gen`);
      ok = false;
    }
  }
  return ok;
}

// MARK: build

/**
 * The UI build plugins: bunfig.toml's [serve.static] plugins, the list the
 * dev server uses. One list, so dev and release can't drift.
 */
export async function plugins(c: Resolved): Promise<BunPlugin[]> {
  const f = Bun.file(rel(c, "bunfig.toml"));
  if (!(await f.exists())) return [];
  const toml = Bun.TOML.parse(await f.text()) as {
    serve?: { static?: { plugins?: string[] } };
  };
  const list = toml.serve?.static?.plugins ?? [];
  return Promise.all(
    list.map(async (spec) => {
      const m = await import(Bun.resolveSync(spec, c.root));
      return m.default as BunPlugin;
    }),
  );
}

/**
 * Compile the core: the entry, its UI (HTML imports, bundled with the
 * plugins), and SQLite if it uses it, in one binary.
 *
 * `aot` (default on) compiles ahead of time; `trim` then drops the Bun and
 * Node.js APIs the core never calls (about 12 MB). A call to a dropped
 * API throws ERR_FEATURE_REMOVED at run time, and `bun test` can't see
 * it. After adding a dependency or a new Bun API, run
 *   bun build --compile --aot --trim --explain=trim ./<entry>
 * and check that nothing you need was removed.
 */
export async function build(c: Resolved, opts: { aot?: boolean } = {}) {
  const ps = check(c);
  if (ps.length)
    throw new Error(`steambun: code crosses runtimes\n${report(ps)}`);
  if (!c.core) return buildPage(c);
  if (c.bun === "system") return buildScript(c, c.core);
  const aot = opts.aot ?? true;
  const outfile = paths(c).core;
  rmSync(paths(c).script, { recursive: true, force: true });
  const r = await Bun.build({
    entrypoints: [rel(c, c.core)],
    compile: { outfile, aot, trim: aot } as Bun.CompileBuildOptions,
    plugins: await plugins(c),
    minify: true,
    target: "bun",
  });
  for (const l of r.logs) console.error(String(l));
  if (!r.success) throw new Error("steambun: build failed");
  say(`built ${c.out}/core/${c.name}${aot ? " (aot, trimmed)" : ""}`);
}

/**
 * Bundle the core as plain JS for `bun: "system"`: the entry, with its
 * page's files beside it, into build/core. The user's `bun` runs it from
 * that folder, since Bun finds the page's files from the working folder.
 */
async function buildScript(c: Resolved, entry: string) {
  const outdir = paths(c).script;
  rmSync(outdir, { recursive: true, force: true });
  const r = await Bun.build({
    entrypoints: [rel(c, entry)],
    outdir,
    plugins: await plugins(c),
    minify: true,
    target: "bun",
  });
  for (const l of r.logs) console.error(String(l));
  if (!r.success) throw new Error("steambun: build failed");
  const kb = r.outputs.reduce((n, o) => n + o.size, 0) / 1024;
  say(
    `built ${c.out}/core (${kb.toFixed(0)} KB, runs on bun ${c.minBun} or later)`,
  );
}

/**
 * Bundle the page for an app with no core: the HTML entry and what it
 * imports, minified, into build/page. The shell serves it from inside the
 * .app at steambun://app/.
 */
async function buildPage(c: Resolved) {
  const outdir = paths(c).page;
  rmSync(outdir, { recursive: true, force: true });
  const r = await Bun.build({
    entrypoints: [rel(c, c.page)],
    outdir,
    plugins: await plugins(c),
    minify: true,
    target: "browser",
  });
  for (const l of r.logs) console.error(String(l));
  if (!r.success) throw new Error("steambun: build failed");
  const kb = r.outputs.reduce((n, o) => n + o.size, 0) / 1024;
  say(`built ${c.out}/page (${kb.toFixed(0)} KB, no core)`);
}

/**
 * Bundle the page as a static site in build/web, to host on the web with
 * the same UI as the app. Outside the shell, `native.has()` is false and
 * settings stay in localStorage, so the page needs no changes. With a
 * core, the page's calls to the core's API need a server of your own.
 */
export async function buildWeb(c: Resolved) {
  const ps = check(c).filter((p) => p.side === "page");
  if (ps.length) throw new Error(`steambun: the page uses Bun\n${report(ps)}`);
  const entries = pageEntries(c);
  if (!entries.length)
    throw new Error(`steambun: no page found: ${c.core} imports no .html file`);
  const outdir = paths(c).web;
  rmSync(outdir, { recursive: true, force: true });
  const r = await Bun.build({
    entrypoints: entries,
    outdir,
    plugins: await plugins(c),
    minify: true,
    target: "browser",
  });
  for (const l of r.logs) console.error(String(l));
  if (!r.success) throw new Error("steambun: build failed");
  const kb = r.outputs.reduce((n, o) => n + o.size, 0) / 1024;
  say(`built ${c.out}/web (${kb.toFixed(0)} KB, static)`);
  if (c.core)
    say(
      "the page may call the core's API: on the web, serve it from the same origin, with its own auth",
    );
}

// MARK: app

export type AppOptions = {
  /** The compiled core to bundle. Default: build/core/<name>. */
  core?: string;
  /** "core" (default) or "core-jit": only a non-AOT core needs JIT. */
  entitlements?: string;
  /** A Developer ID identity. Default "-": ad hoc. */
  sign?: string;
  /** CFBundleShortVersionString. Default 0.0.1. */
  version?: string;
  /** CFBundleVersion: a number that only goes up. Default: commit count. */
  build?: string;
  /** The update feed and its ed25519 public key. Default: the config's. */
  updateURL?: string;
  updateKey?: string;
  /** Where libzstd lives (the updater links it). Default: Homebrew's. */
  zstd?: string;
};

/**
 * Build <out>/<name>.app: generate the Swift, compile the framework's and
 * the app's sources with one swiftc call, write Info.plist, copy the core,
 * and sign inside out with the hardened runtime.
 */
export async function app(c: Resolved, o: AppOptions = {}) {
  const P = paths(c);
  const core = o.core ?? P.core;
  const built = !c.core
    ? join(P.page, "index.html")
    : c.bun === "system"
      ? join(P.script, coreScript(c.core))
      : core;
  if (!existsSync(built))
    throw new Error(`steambun: nothing at ${built}; run steambun build`);
  const zstd =
    o.zstd ??
    ((await $`brew --prefix zstd`.nothrow().quiet().text()).trim() ||
      "/opt/homebrew/opt/zstd");
  if (!existsSync(`${zstd}/lib/libzstd.a`))
    throw new Error(`steambun: no libzstd.a in ${zstd}; brew install zstd`);
  const build =
    o.build ??
    ((
      await $`git rev-list --count HEAD`.cwd(c.root).nothrow().quiet().text()
    ).trim() ||
      "1");
  const pub = Bun.file(rel(c, "native/.keys/update.pub"));
  const updateKey =
    o.updateKey ??
    c.update.key ??
    ((await pub.exists()) ? (await pub.text()).trim() : "");

  rmSync(P.app, { recursive: true, force: true });
  const helpers = c.core && c.bun === "bundled";
  for (const d of ["MacOS", ...(helpers ? ["Helpers"] : []), "Resources"])
    mkdirSync(`${P.app}/Contents/${d}`, { recursive: true });

  await gen(c);
  // Every .swift file in each folder: a new file needs no change here.
  const swift = (dir: string) =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith(".swift"))
          .map((f) => join(dir, f))
      : [];
  const sources = [
    ...swift(join(NATIVE, "Sources")),
    ...swift(rel(c, c.swift)),
    ...swift(P.gen),
  ];
  // libzstd is linked statically: macOS doesn't ship it.
  await $`swiftc -O -whole-module-optimization \
    -target arm64-apple-macos14.0 \
    -import-objc-header ${NATIVE}/Sources/bridge.h -I ${zstd}/include \
    -Xlinker ${zstd}/lib/libzstd.a \
    -o ${P.shell} ${sources}`
    .quiet()
    .catch((e) => {
      throw new Error(`steambun: swiftc failed\n${e.stderr}`);
    });

  await Bun.write(
    `${P.app}/Contents/Info.plist`,
    infoPlist(c, {
      version: o.version ?? "0.0.1",
      build,
      updateURL: o.updateURL ?? c.update.url ?? "",
      updateKey,
    }),
  );
  if (c.icon)
    copyFileSync(rel(c, c.icon), `${P.app}/Contents/Resources/AppIcon.icns`);
  const id = o.sign ?? "-";
  if (id !== "-" && c.idDefault)
    throw new Error(
      `steambun: set an id in steambun.config.ts before a signed build. ` +
        `The id names the app's data, so it can't change after you ship (now ${c.id}).`,
    );
  const helper = `${P.app}/Contents/Helpers/${c.name}-core`;
  if (c.core && c.bun === "system") {
    // The user's bun runs Resources/core/<entry>.js.
    cpSync(P.script, `${P.app}/Contents/Resources/core`, { recursive: true });
  } else if (c.core) {
    copyFileSync(core, helper);
    chmodSync(helper, 0o755);
    // Inside out: the core, then the shell, then the bundle.
    const ent = o.entitlements ?? "core";
    await $`codesign --force --options runtime --timestamp=none -s ${id} \
      --identifier ${c.id}.core \
      --entitlements ${NATIVE}/entitlements/${ent}.plist ${helper}`.quiet();
  } else {
    // No core: the shell serves the page from Resources/page.
    cpSync(P.page, `${P.app}/Contents/Resources/page`, { recursive: true });
  }
  await $`codesign --force --options runtime --timestamp=none -s ${id} \
    --entitlements ${NATIVE}/entitlements/shell.plist ${P.app}`.quiet();
  await $`codesign --verify --deep --strict ${P.app}`.quiet();
  const res = `${P.app}/Contents/Resources`;
  await $`du -sh ${P.app} ${P.shell} ${helpers ? helper : c.core ? `${res}/core` : `${res}/page`}`;
}

// MARK: test

/**
 * Why the built shell is out of date, or null. The shell is stale when any
 * of its inputs is newer: the framework's Swift, the app's Swift, its
 * bridge, its config, or package.json. Tests run the page and core from
 * source, so only the shell needs a build.
 */
export function shellStale(c: Resolved): string | null {
  const shell = paths(c).shell;
  if (!existsSync(shell)) return "no shell yet";
  const built = statSync(shell).mtimeMs;
  const files = (dir: string, ext: string[]) =>
    existsSync(dir)
      ? readdirSync(dir, { recursive: true, encoding: "utf8" })
          .filter((f) => ext.some((e) => f.endsWith(e)))
          .map((f) => join(dir, f))
      : [];
  const inputs = [
    ...files(join(NATIVE, "Sources"), [".swift", ".h"]),
    join(FW, "bridge.ts"),
    ...files(rel(c, c.swift), [".swift"]),
    ...(c.bridge ? [rel(c, c.bridge)] : []),
    rel(c, "steambun.config.ts"),
    rel(c, "package.json"),
  ];
  for (const f of inputs)
    if (existsSync(f) && statSync(f).mtimeMs > built)
      return `${relative(c.root, f)} changed`;
  return null;
}

export type TestOptions = {
  /** Which backends to run. Default: native. */
  backends?: ("native" | "tab")[];
  /** Arguments for `bun test`: files or folders, -t, --bail. */
  args?: string[];
  /** Run test files at once, one worker each. Default: true. */
  parallel?: boolean;
};

/**
 * Rebuild the shell if it's stale, then run `bun test` once per backend.
 * Returns the worst exit code.
 */
export async function test(c: Resolved, o: TestOptions = {}): Promise<number> {
  const backends = o.backends ?? ["native"];
  if (backends.includes("native")) {
    const why = shellStale(c);
    if (why) {
      say(`${why}: building the shell`);
      // app() bundles what build() makes: the core, or the page alone.
      await build(c);
      await app(c);
    }
  }
  // bun test skips *.e2e.ts unless named, so name them: every one under
  // each folder given, or under the root if no file or folder is given.
  const args = o.args ?? [];
  const isPath = (a: string) => !a.startsWith("-") && existsSync(rel(c, a));
  const e2e = (dir: string) =>
    [...new Bun.Glob("**/*.e2e.ts").scanSync({ cwd: rel(c, dir) })]
      .filter((f) => !/(^|\/)(node_modules|build)\//.test(f))
      .map((f) => `./${join(dir, f)}`);
  const paths_ = args.filter(isPath);
  const rest = args.filter((a) => !isPath(a));
  const files = (paths_.length ? paths_ : ["."]).flatMap((a) =>
    statSync(rel(c, a)).isDirectory()
      ? e2e(a)
      : // bun test reads a bare name as a filter; ./ makes it a path.
        [a.startsWith("/") || a.startsWith(".") ? a : `./${a}`],
  );
  if (!files.length) {
    say("no *.e2e.ts files");
    return 1;
  }
  // Each launch has its own home, WebKit store and port, so files can run
  // at once: one bun worker per file.
  const par =
    o.parallel !== false &&
    files.length > 1 &&
    !rest.some((a) => a.startsWith("--parallel"))
      ? ["--parallel"]
      : [];
  let code = 0;
  for (const b of backends) {
    if (backends.length > 1) say(`${b} backend`);
    const p = Bun.spawn(["bun", "test", ...par, ...files, ...rest], {
      cwd: c.root,
      env: { ...Bun.env, STEAMBUN_TEST_BACKEND: b },
      stdio: ["inherit", "inherit", "inherit"],
    });
    code = Math.max(code, await p.exited);
  }
  return code;
}

// MARK: dev

/**
 * Run the core from source under `bun --hot`. In a tab by default; with
 * `native`, inside the built shell (run `steambun app` once, and again
 * after Swift changes), so UI and core edits still apply live.
 *
 * With no core, a small dev server (devpage.ts) serves the page with hot
 * reload, and the shell loads it in place of steambun://app/.
 */
export async function dev(
  c: Resolved,
  o: {
    native?: boolean;
    home?: string;
    /** The core's port. Default: STEAMBUN_PORT, then the config's. */
    port?: number;
    args?: string[];
    env?: Record<string, string>;
  } = {},
): Promise<number> {
  const args = o.args ?? [];
  const env = {
    ...Bun.env,
    ...o.env,
    ...(o.port && { STEAMBUN_PORT: String(o.port) }),
  };
  const entry = c.core
    ? [rel(c, c.core)]
    : [join(FW, "devpage.ts"), rel(c, c.page)];
  const kill = (...ps: Bun.Subprocess[]) => {
    for (const s of ["SIGINT", "SIGTERM"] as const)
      process.on(s, () => ps.forEach((p) => p.kill(s)));
  };
  if (!o.native) {
    // The config's port, unless the caller picked one.
    const p = Bun.spawn(["bun", "--hot", ...entry, ...args], {
      cwd: c.root,
      env: {
        STEAMBUN_PORT: String(c.port),
        ...env,
        ...(o.home && { STEAMBUN_HOME: o.home }),
      },
      stdio: ["inherit", "inherit", "inherit"],
    });
    kill(p);
    return p.exited;
  }
  const { shell } = paths(c);
  const why = shellStale(c);
  if (why) {
    say(`${why}: building the shell`);
    if (c.core) await build(c);
    await app(c);
  }
  const shellArgs = [
    ...(o.home ? ["-STEAMBUN_HOME", o.home] : []),
    "-STEAMBUN_LOG",
    "/dev/null",
  ];
  if (!c.core) {
    // The page's dev server, then the shell pointed at it.
    const port = String(env.STEAMBUN_PORT ?? c.port);
    const server = Bun.spawn(["bun", "--hot", ...entry, ...args], {
      cwd: c.root,
      env: {
        ...env,
        STEAMBUN_PORT: port,
        STEAMBUN_PARENT_PID: String(process.pid),
      },
      stdio: ["inherit", "pipe", "inherit"],
    });
    const url = await readyURL(server);
    const p = Bun.spawn([shell, ...shellArgs], {
      env: { ...env, STEAMBUN_URL: url, STEAMBUN_INSPECT: "1" },
      stdio: ["inherit", "inherit", "inherit"],
    });
    kill(p, server);
    const code = await p.exited;
    server.kill();
    return code;
  }
  // The shell runs STEAMBUN_CORE as the core; point it at the source.
  const core = join(tmpdir(), `steambun-dev-core-${process.pid}`);
  const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  await Bun.write(
    core,
    `#!/bin/sh\ncd ${q(c.root)} && exec bun --hot ${entry.map(q).join(" ")} ${args.map(q).join(" ")} "$@"\n`,
  );
  chmodSync(core, 0o755);
  const p = Bun.spawn([shell, ...shellArgs], {
    env: { ...env, STEAMBUN_CORE: core, STEAMBUN_INSPECT: "1" },
    stdio: ["inherit", "inherit", "inherit"],
  });
  kill(p);
  const code = await p.exited;
  rmSync(core, { force: true });
  return code;
}

/** Wait for the dev server's ready line; pass the rest of its output on. */
async function readyURL(
  p: Bun.Subprocess<"inherit", "pipe", "inherit">,
): Promise<string> {
  const reader = p.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("steambun: the page's dev server exited");
    buf += dec.decode(value, { stream: true });
    const m = buf.match(/STEAMBUN_READY (\d+)/);
    if (!m) continue;
    process.stdout.write(buf.replace(/STEAMBUN_READY \d+\n?/, ""));
    (async () => {
      for (;;) {
        const r = await reader.read();
        if (r.done) return;
        process.stdout.write(r.value);
      }
    })();
    return `http://127.0.0.1:${m[1]}${process.env.STEAMBUN_PATH ?? "/"}`;
  }
}
