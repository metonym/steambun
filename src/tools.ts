// The build side of steambun. Each function takes the resolved config
// (config.ts); `steambun <command>` (cli.ts) is a thin wrapper over them.
//
//   gen     the shell's generated Swift: Bridge.gen.swift (the framework's
//           ops), App.gen.swift (the app's ops) and Config.gen.swift
//   build   the page (build/page), or with a core, one AOT binary with
//           the page inside (build/core)
//   app     the .app: the Swift shell, Info.plist, the page or the core,
//           signed
//   test    the *.e2e.ts tests, in the Mac app or a tab
//   dev     the page (or the core) from source under `bun --hot`, in a
//           tab or the shell
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { $ } from "bun";
import type { BunPlugin } from "bun";
import { check, pageEntries, report } from "./check.ts";
import type { Resolved } from "./config.ts";
import { appSwift, frameworkSwift } from "./gen/bridge.ts";
import { configSwift, coreScript, infoPlist } from "./gen/config.ts";
import type { Bridge } from "./schema.ts";
import {
  color,
  done,
  error,
  head,
  info,
  json,
  shown,
  since,
  verbose,
  warn,
} from "./term.ts";

const FW = import.meta.dir;
const NATIVE = join(FW, "native");
const rel = (c: Resolved, p: string) => join(c.root, p);

/** Bytes in a file, or in a folder and everything under it. */
function bytes(p: string): number {
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  return readdirSync(p).reduce((n, f) => n + bytes(join(p, f)), 0);
}

/** Print Bun's build logs. On failure, throw an error that counts them. */
function buildResult(r: Bun.BuildOutput, what: string) {
  // `file:line:col: message`, so an editor or agent can jump to it.
  const place = (l: Bun.BuildOutput["logs"][number]) =>
    l.position
      ? `${shown(l.position.file)}:${l.position.line}:${l.position.column}: ${l.message}`
      : l.message;
  for (const l of r.logs)
    if (l.level === "error") error(place(l));
    else if (l.level === "warning") warn(place(l));
    else if (verbose()) info("bun", place(l));
  if (r.success) return;
  const errors = r.logs.filter((l) => l.level === "error");
  const n = errors.length;
  throw new BuildError(
    `couldn't build ${what}: ${n} error${n === 1 ? "" : "s"}${json.on ? "" : " above"}`,
    errors.map(place),
  );
}

/** A failed build, with Bun's messages for `--json`. */
export class BuildError extends Error {
  constructor(
    msg: string,
    readonly logs: string[],
  ) {
    super(msg);
  }
}

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
 * Write the generated Swift. With `verify`, write nothing and return the
 * stale files, as the caller would type their paths. `verify` checks only
 * the framework's Bridge.gen.swift: the app's files live in build/.
 */
export async function gen(c: Resolved, verify = false): Promise<string[]> {
  const out: [string, string][] = [
    [join(NATIVE, "Sources/Bridge.gen.swift"), frameworkSwift()],
  ];
  if (!verify) {
    const bridge = c.bridge
      ? ((await import(rel(c, c.bridge))).default as Bridge)
      : null;
    out.push(
      [
        join(paths(c).gen, "App.gen.swift"),
        appSwift(bridge, c.bridge ?? "(no bridge)"),
      ],
      [join(paths(c).gen, "Config.gen.swift"), configSwift(c)],
    );
  }
  const stale: string[] = [];
  for (const [path, text] of out) {
    if (!verify) {
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
      stale.push(shown(path));
    }
  }
  return stale;
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
export async function build(
  c: Resolved,
  opts: { aot?: boolean; outfile?: string } = {},
) {
  const ps = check(c);
  if (ps.length > 0) throw new Error(`code crosses runtimes\n${report(ps)}`);
  if (!c.core) return buildPage(c);
  if (c.bun === "system") return buildScript(c, c.core);
  const aot = opts.aot ?? true;
  const outfile = opts.outfile ?? paths(c).core;
  // Drop a stale "system" build there, unless the core goes elsewhere.
  if (!opts.outfile) rmSync(paths(c).script, { recursive: true, force: true });
  const t0 = performance.now();
  const r = await Bun.build({
    entrypoints: [rel(c, c.core)],
    compile: { outfile, aot, trim: aot } as Bun.CompileBuildOptions,
    plugins: await plugins(c),
    minify: true,
    target: "bun",
    define: inlined(c).define,
    throw: false,
  });
  buildResult(r, "the core");
  done({
    step: "core",
    path: shown(outfile),
    bytes: bytes(outfile),
    note: [aot ? "AOT, trimmed" : "JIT", inlined(c).note]
      .filter(Boolean)
      .join(" · "),
    ms: since(t0),
  });
}

/**
 * `inline` as Bun's `define`: exact names only, so a var that merely
 * shares a prefix (say, a token in .env) never ships in the app.
 */
function inlined(c: Resolved) {
  const set = c.inline.filter((v) => Bun.env[v] !== undefined);
  return {
    define: Object.fromEntries(
      set.map((v) => [`process.env.${v}`, JSON.stringify(Bun.env[v])]),
    ),
    note: set.length > 0 ? `inlined ${set.join(", ")}` : undefined,
  };
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
    define: inlined(c).define,
    throw: false,
  });
  buildResult(r, "the core");
  done({
    step: "core",
    path: shown(outdir),
    bytes: r.outputs.reduce((n, o) => n + o.size, 0),
    note: [`runs on bun ${c.minBun} or later`, inlined(c).note]
      .filter(Boolean)
      .join(" · "),
  });
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
    throw: false,
  });
  buildResult(r, "the page");
  done({
    step: "page",
    path: shown(outdir),
    bytes: r.outputs.reduce((n, o) => n + o.size, 0),
  });
}

/**
 * Bundle the page as a static site in build/web, to host on the web with
 * the same UI as the app. Outside the shell, `native.has()` is false and
 * settings stay in localStorage, so the page needs no changes. With a
 * core, the page's calls to the core's API need a server of your own.
 */
export async function buildWeb(c: Resolved) {
  const ps = check(c).filter((p) => p.side === "page");
  if (ps.length > 0) throw new Error(`the page uses Bun\n${report(ps)}`);
  const entries = pageEntries(c);
  if (entries.length === 0)
    throw new Error(`no page found: ${c.core} imports no .html file`);
  const outdir = paths(c).web;
  rmSync(outdir, { recursive: true, force: true });
  const r = await Bun.build({
    entrypoints: entries,
    outdir,
    plugins: await plugins(c),
    minify: true,
    target: "browser",
    throw: false,
  });
  buildResult(r, "the page");
  done({
    step: "web",
    path: shown(outdir),
    bytes: r.outputs.reduce((n, o) => n + o.size, 0),
    note: "a static site",
  });
  if (c.core)
    warn(
      "the page may call the core's API: on the web, serve it from the same origin, with its own auth",
    );
}

// MARK: app

export interface AppOptions {
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
}

/**
 * Build <out>/<name>.app: generate the Swift, compile the framework's and
 * the app's sources with one swiftc call, write Info.plist, copy the core,
 * and sign inside out with the hardened runtime.
 */
export async function app(c: Resolved, o: AppOptions = {}) {
  const t0 = performance.now();
  const P = paths(c);
  const core = o.core ?? P.core;
  let built = core;
  if (!c.core) built = join(P.page, "index.html");
  else if (c.bun === "system") built = join(P.script, coreScript(c.core));
  if (!existsSync(built))
    throw new Error(`nothing at ${shown(built)}: run steambun build`);
  const zstd =
    o.zstd ??
    ((await $`brew --prefix zstd`.nothrow().quiet().text()).trim() ||
      "/opt/homebrew/opt/zstd");
  if (!existsSync(`${zstd}/lib/libzstd.a`))
    throw new Error(`no libzstd.a in ${zstd}; brew install zstd`);
  const buildNo =
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
  const tSwift = performance.now();
  if (await compileShell(c, sources, zstd))
    done({ step: "shell", note: "compiled", ms: since(tSwift) });
  else done({ step: "shell", note: "reused: no Swift changed" });

  await Bun.write(
    `${P.app}/Contents/Info.plist`,
    infoPlist(c, {
      version: o.version ?? "0.0.1",
      build: buildNo,
      updateURL: o.updateURL ?? c.update.url ?? "",
      updateKey,
    }),
  );
  if (c.icon)
    copyFileSync(rel(c, c.icon), `${P.app}/Contents/Resources/AppIcon.icns`);
  const id = o.sign ?? "-";
  if (id !== "-" && c.idDefault)
    throw new Error(
      `set an id in the config before a signed build. ` +
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
  done({
    step: "app",
    path: shown(P.app),
    bytes: bytes(P.app),
    note: id === "-" ? "signed ad hoc" : `signed as ${id}`,
    ms: since(t0),
  });
}

/**
 * Compile the shell, or reuse the last compile when nothing it depends on
 * changed: the sources' content, the flags, libzstd and the compiler.
 * swiftc is almost all of `steambun app`'s time, and most rebuilds change
 * only the page, the core or Info.plist.
 */
async function compileShell(
  c: Resolved,
  sources: string[],
  zstd: string,
): Promise<boolean> {
  const P = paths(c);
  const header = join(NATIVE, "Sources/bridge.h");
  // libzstd is linked statically: macOS doesn't ship it.
  const args = [
    "-O",
    "-whole-module-optimization",
    "-target",
    "arm64-apple-macos14.0",
    "-import-objc-header",
    header,
    "-I",
    `${zstd}/include`,
    "-Xlinker",
    `${zstd}/lib/libzstd.a`,
  ];
  const swiftc = (await $`xcrun --find swiftc`.quiet().text()).trim();
  const h = new Bun.CryptoHasher("sha256");
  h.update(args.join("\0"));
  // The compiler: a new Xcode or toolchain makes a new binary.
  h.update(`${realpathSync(swiftc)} ${statSync(realpathSync(swiftc)).mtimeMs}`);
  // The SDK, when SDKROOT picks one other than the compiler's default.
  h.update(process.env.SDKROOT ?? "");
  h.update(String(statSync(`${zstd}/lib/libzstd.a`).mtimeMs));
  for (const f of [header, ...sources].toSorted()) {
    h.update(f);
    h.update(await Bun.file(f).bytes());
  }
  const key = h.digest("hex");
  const cached = rel(c, `${c.out}/cache/shell`);
  const cachedKey = Bun.file(`${cached}.key`);
  if (
    existsSync(cached) &&
    (await cachedKey.exists()) &&
    (await cachedKey.text()) === key
  ) {
    copyFileSync(cached, P.shell);
    return false;
  }
  await $`swiftc ${args} -o ${P.shell} ${sources}`.quiet().catch((e) => {
    throw new Error(`swiftc failed:\n${e.stderr}`);
  });
  // Before signing, which changes the file. The key goes last, so a
  // copy cut short never matches.
  mkdirSync(join(cached, ".."), { recursive: true });
  rmSync(`${cached}.key`, { force: true });
  copyFileSync(P.shell, cached);
  await Bun.write(`${cached}.key`, key);
  return true;
}

// MARK: test

/**
 * Why the built shell is out of date, or null. The shell is stale when any
 * of its inputs is newer: the framework's Swift, the app's Swift, its
 * bridge, its config, or package.json. Dev and tests run the page and
 * the core from source, so only the shell needs a build.
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

/**
 * Build what app() bundles, then the .app, when dev or test finds the
 * shell stale. Both run the core from source, so the .app's core only has
 * to exist: a JIT build takes ~20 ms, where AOT takes ~0.7 s. It goes to
 * build/cache, so build/core keeps the AOT core a release ships. Testing
 * the built app (`built`) gets the AOT core, as shipped.
 */
async function buildForShell(c: Resolved, built: boolean) {
  if (built || !c.core || c.bun !== "bundled") {
    await build(c);
    return app(c);
  }
  const core = rel(c, `${c.out}/cache/core-jit`);
  await build(c, { aot: false, outfile: core });
  await app(c, { core, entitlements: "core-jit" });
}

export interface TestOptions {
  /** Which backends to run. Default: native. */
  backends?: ("native" | "tab")[];
  /** Arguments for `bun test`: files or folders, -t, --bail. */
  args?: string[];
  /** Run test files at once, one worker each. Default: true. */
  parallel?: boolean;
}

/**
 * Rebuild the shell if it's stale, then run `bun test` once per backend.
 * Returns the worst exit code.
 */
export async function test(c: Resolved, o: TestOptions = {}): Promise<number> {
  const backends = o.backends ?? ["native"];
  if (backends.includes("native")) {
    const why = shellStale(c);
    if (why) {
      info("shell", `${why}: building it`);
      await buildForShell(c, Bun.env.STEAMBUN_TEST_BUILT === "1");
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
  const files = (paths_.length > 0 ? paths_ : ["."]).flatMap((a) =>
    statSync(rel(c, a)).isDirectory()
      ? e2e(a)
      : // bun test reads a bare name as a filter; ./ makes it a path.
        [a.startsWith("/") || a.startsWith(".") ? a : `./${a}`],
  );
  if (files.length === 0) {
    error("no *.e2e.ts files here");
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
    if (backends.length > 1)
      head(`steambun test · ${b === "native" ? "the Mac app" : "a tab"}`);
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
 * `native`, inside the shell, which it builds first if it's stale. UI and
 * core edits apply live either way.
 *
 * With no core, a small dev server (devpage.ts) serves the page with hot
 * reload, and the shell loads it in place of steambun://app/. Resolves to
 * the exit code.
 */
export async function dev(
  c: Resolved,
  o: {
    native?: boolean;
    home?: string;
    /** The core's or the page's port. Default: STEAMBUN_PORT, then the config's. */
    port?: number;
    args?: string[];
    env?: Record<string, string>;
  } = {},
): Promise<number> {
  const args = o.args ?? [];
  const env = {
    ...Bun.env,
    // bunx and bun run each add every node_modules/.bin up to /: once is enough.
    PATH: [...new Set((Bun.env.PATH ?? "").split(":"))].join(":"),
    // The page, the core and the shell write to this terminal through
    // pipes: tell them whether it takes color.
    ...(color && !Bun.env.NO_COLOR && { FORCE_COLOR: "1" }),
    ...o.env,
    ...(o.port && { STEAMBUN_PORT: String(o.port) }),
  };
  const what = c.core ? "the core" : "the page";
  head(
    `steambun dev · ${c.name} · ${what} ${o.native ? "in the Mac app" : "in a tab"}, with hot reload · ctrl-c quits`,
  );
  const entry = c.core
    ? [rel(c, c.core)]
    : [join(FW, "devpage.ts"), rel(c, c.page)];
  const kill = (...ps: Bun.Subprocess[]) => {
    for (const s of ["SIGINT", "SIGTERM"] as const)
      process.on(s, () => {
        for (const p of ps) p.kill(s);
      });
  };
  if (!o.native) {
    // The config's port, unless --port or STEAMBUN_PORT picks one.
    const p = Bun.spawn(["bun", "--hot", ...entry, ...args], {
      cwd: c.root,
      env: {
        STEAMBUN_PORT: String(c.port),
        ...env,
        ...(o.home && { STEAMBUN_HOME: o.home }),
      },
      stdio: ["inherit", "inherit", "pipe"],
    });
    quietBun(p.stderr);
    kill(p);
    return p.exited;
  }
  const { shell } = paths(c);
  const why = shellStale(c);
  if (why) {
    info("shell", `${why}: building it`);
    await buildForShell(c, false);
  }
  // Every line, the shell's detail too, for when something goes wrong.
  const logFile = rel(c, `${c.out}/dev.log`);
  info(
    "log",
    `${shown(logFile)}${verbose() ? "" : " (--verbose prints every line here)"}`,
  );
  const shellArgs = [
    ...(o.home ? ["-STEAMBUN_HOME", o.home] : []),
    "-STEAMBUN_LOG",
    logFile,
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
      stdio: ["inherit", "pipe", "pipe"],
    });
    quietBun(server.stderr);
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

/**
 * Bun's dev server prints "Bundled page in 2ms: index.html" on each load:
 * a timing, so only with --verbose. Pass every other line on to stderr.
 */
const BUN_TIMING = /^Bundled page in \d+ms/;
async function quietBun(from: ReadableStream<Uint8Array>) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of from) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const l of lines)
      if (verbose() || !BUN_TIMING.test(Bun.stripANSI(l)))
        process.stderr.write(`${l}\n`);
  }
  if (buf) process.stderr.write(buf);
}

/** Wait for the dev server's ready line; pass the rest of its output on. */
async function readyURL(
  p: Bun.Subprocess<"inherit", "pipe", "pipe">,
): Promise<string> {
  const reader = p.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done: ended } = await reader.read();
    if (ended) throw new Error("the page's dev server exited");
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
    return `http://127.0.0.1:${m[1]}/`;
  }
}
