import { afterAll, beforeAll, describe, test as bunTest } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
// Drive a steambun app from `bun test`.
//
//   import { describeApp, test } from "steambun/test";
//   await describeApp({ root, ready: "h1" }, (app) => {
//     test("…", async () => expect(await app.js("…")).toBe("…"));
//   });
//
// describeApp launches once for the block, closes after, and skips the
// block (with the reason) where the app can't run. Or launch by hand:
//
//   import { launch } from "steambun/test";
//   const app = await launch({ ready: "h1" });
//   await app.key("mod+k");
//   expect(await app.js("document.activeElement.placeholder")).toBe("Search");
//   await app.close();
//
// Two backends, one API:
//
//   native  the built shell (steambun app). The harness serves a WebSocket;
//           the shell links to it (STEAMBUN_TEST_WS) and runs TEST_OPS
//           (bridge.ts, native/Sources/Test.swift). Input goes through AppKit
//           as real events, so menus and key equivalents see it first.
//   tab     a Bun.WebView on the page, with no shell. Faster to start and
//           needs no build. Native-only calls (menu, state, system, paste)
//           throw; check `app.native` to skip them.
//
// STEAMBUN_TEST_BACKEND=tab picks the tab backend for every launch.
// The native backend runs the app hidden: no Dock icon, no focus taken,
// an invisible window. STEAMBUN_TEST_SHOW=1 shows it, to watch a run.
//
// The core and the page run from source, so an edit needs no build. With
// STEAMBUN_TEST_BUILT=1, the native backend tests the built .app as shipped.
//
// Each launch gets a fresh temp home (STEAMBUN_HOME) and, in the shell, its
// own web data store (STEAMBUN_STORE). localStorage and cookies a test
// writes never reach the next test or the real app. `seed` fills the home
// before launch; `relaunch()` keeps both, to test what survives a restart.
//
// Import `test` from here, not bun:test: when a test fails, it saves a
// screenshot, the page's HTML and the logs of each open app to
// <out>/test-failures/<test name>/, and prints the folder.
import type { ServerWebSocket, Subprocess } from "bun";
import type { TestArgs, TestOp, TestResult } from "./bridge.ts";
import { loadConfig, loadConfigSync, type Resolved } from "./config.ts";
import { paths } from "./tools.ts";

const FW = import.meta.dir;

export type Backend = "native" | "tab";

export interface LaunchOpts {
  /** The app's root folder. Default: the current folder. */
  root?: string;
  /** native (default) or tab. Default from STEAMBUN_TEST_BACKEND. */
  backend?: Backend;
  /** Fill the temp home before launch: copy a db, write files. */
  seed?: (home: string) => void | Promise<void>;
  /** Resolve once this selector matches. Default: "body". */
  ready?: string;
  /** Run the core or page server under `bun --hot`. */
  hot?: boolean;
  /** Extra environment for the core (and the shell). */
  env?: Record<string, string>;
  /** Arguments after the core's entry, as `steambun dev -- <args>`. */
  args?: string[];
  /** Test the built .app, not the source. Default: STEAMBUN_TEST_BUILT=1. */
  built?: boolean;
  /** Load this URL in place of the app's page. The core still starts. */
  url?: string;
  /**
   * Bring the app forward and wait for its page. Default true. False
   * returns once the shell links: a menu bar app's panel stays closed and,
   * with a core, its page unloaded. Call `activate()` and `waitPage()` later.
   */
  front?: boolean;
  /** Window or view size in the tab backend. */
  size?: { width: number; height: number };
}

/** Why `launch()` can't run here, or null if it can. */
export async function whyNot(
  o: Pick<LaunchOpts, "root" | "backend" | "built"> = {},
) {
  return whyNotSync(o);
}

function whyNotSync(o: Pick<LaunchOpts, "root" | "backend" | "built">) {
  if (process.platform !== "darwin") return "not macOS";
  const c = loadConfigSync(resolve(o.root ?? "."));
  if (backendOf(o) === "tab") return null;
  if (!existsSync(paths(c).shell))
    return `no shell: run steambun app in ${c.root}`;
  if (builtOf(o) && c.core && !existsSync(paths(c).core) && c.bun !== "system")
    return "no built core: run steambun build";
  return null;
}

const backendOf = (o: LaunchOpts): Backend =>
  o.backend ?? (Bun.env.STEAMBUN_TEST_BACKEND === "tab" ? "tab" : "native");
const builtOf = (o: LaunchOpts) =>
  o.built ?? Bun.env.STEAMBUN_TEST_BUILT === "1";

export type App = Awaited<ReturnType<typeof launch>>;

/** Apps launched and not yet closed: a failed test saves each one's state. */
const open = new Set<App>();

type TestFn = () => unknown;
const saving =
  (name: string, fn: TestFn): TestFn =>
  async () => {
    try {
      await fn();
    } catch (e) {
      for (const app of open) {
        const dir = await app.saveFailure(name).catch(() => null);
        if (dir) console.error(`  saved: ${dir}`);
      }
      throw e;
    }
  };
type Opts = number | { timeout?: number; retry?: number; repeats?: number };
type Run = (n: string, f: TestFn, o?: Opts) => void;
/**
 * A test drives a real app, and a relaunch alone can take seconds on a slow
 * CI runner. Bun's 5 s default flakes there. It also ties with waitFor's
 * 5 s, so the test could time out before waitFor says what it waited for.
 */
const TEST_TIMEOUT_MS = 30_000;
function withTimeout(o?: Opts): Opts {
  if (typeof o === "number") return o;
  return { timeout: TEST_TIMEOUT_MS, ...o };
}
// bun:test's overloads don't narrow to one signature; this is the one used.
const wrapTest = (t: unknown) => (name: string, fn: TestFn, o?: Opts) =>
  (t as Run)(name, saving(name, fn), withTimeout(o));

/**
 * bun:test's `test`, plus: when the test fails, save each open app's
 * screenshot, HTML and logs, and print the folder.
 */
export const test = Object.assign(wrapTest(bunTest), {
  // Read on use: in CI, bun throws as soon as bunTest.only is read.
  only: (name: string, fn: TestFn, o?: Opts) =>
    wrapTest(bunTest.only)(name, fn, o),
  skip: bunTest.skip,
  todo: bunTest.todo,
  if: (c: boolean) => wrapTest(bunTest.if(c)),
  skipIf: (c: boolean) => wrapTest(bunTest.skipIf(c)),
});
/** `it`, as bun:test names it too. @alias */
export const it = test;

export interface ClickOpts {
  /** 2 for a double click. */
  count?: 1 | 2 | 3;
  mods?: ("shift" | "ctrl" | "alt" | "meta")[];
}

/** An element's box and styles, from `app.layout()`. */
export interface Box {
  tag: string;
  /** Its id or first class, to tell boxes apart. */
  name: string;
  /** The first 40 characters of its text. */
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The computed styles asked for. */
  style: Record<string, string>;
}

const LAYOUT_STYLES = [
  "display",
  "color",
  "background-color",
  "font-size",
  "font-weight",
  "line-height",
  "padding",
  "margin",
  "gap",
  "border-radius",
  "opacity",
];

interface Call {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  op: string;
}

/**
 * A describe block with the app launched once for it: `app` is ready in
 * every test, and closes after the block. Skips the block, and says why,
 * where the app can't run (not macOS, or no built shell).
 */
export function describeApp(
  opts: LaunchOpts & { name?: string },
  fn: (app: App) => void,
): void {
  const root = resolve(opts.root ?? ".");
  const name = opts.name ?? basename(root);
  // At once, not awaited: bun test collects describe blocks as the file
  // loads, so a block registered after an await is lost when the caller
  // forgets the await. It ran 0 tests and passed.
  const why = whyNotSync({ ...opts, root });
  if (why) console.warn(`${name}: tests skipped: ${why}`);
  let current: App | undefined;
  // Tests get this before launch; each use reads the live app.
  const app = new Proxy({} as App, {
    get: (_, k) => {
      if (!current) throw new Error(`${name}: the app isn't launched yet`);
      return current[k as keyof App];
    },
  });
  (why ? describe.skip : describe)(name, () => {
    beforeAll(async () => {
      current = await launch({ ...opts, root });
    }, 60_000);
    afterAll(() => current?.close());
    fn(app);
  });
}

/** Start the app on a fresh home. Close it with `app.close()`. */
export async function launch(opts: LaunchOpts = {}) {
  const c = await loadConfig(resolve(opts.root ?? "."));
  const backend = backendOf(opts);
  const home = mkdtempSync(join(tmpdir(), `steambun-test-${c.name}-`));
  const store = crypto.randomUUID();
  await opts.seed?.(home);
  const s =
    backend === "native"
      ? await startNative(c, opts, home, store)
      : await startTab(c, opts, home);
  const app = wrap(c, opts, home, store, backend, s);
  await app.start();
  open.add(app);
  return app;
}

/** What a backend gives the shared API. */
interface Session {
  /** Run a function body in the page, awaited. */
  eval: <T>(body: string) => Promise<T>;
  call?: <K extends TestOp>(
    op: K,
    args?: TestArgs<K>,
  ) => Promise<TestResult<K>>;
  key: (chord: string) => Promise<unknown>;
  type: (text: string) => Promise<unknown>;
  /** A trusted click at page point (x, y). */
  click: (x: number, y: number, o: ClickOpts) => Promise<unknown>;
  /** The page as a PNG. */
  screenshot: () => Promise<Uint8Array>;
  log: string;
  /** Stop the processes. Keep the home and store. */
  stop: () => Promise<void>;
}

function wrap(
  c: Resolved,
  opts: LaunchOpts,
  home: string,
  store: string,
  backend: Backend,
  first: Session,
) {
  let s = first;
  const ready = opts.ready ?? "body";
  const native = backend === "native";

  function call<K extends TestOp>(
    op: K,
    ...a: TestArgs<K> extends void ? [] : [TestArgs<K>]
  ): Promise<TestResult<K>> {
    if (!s.call) throw new Error(`${op}: native only; this is the tab backend`);
    return s.call(op, a[0] as TestArgs<K>);
  }

  const evalJs = <T = unknown>(body: string) => s.eval<T>(body);
  // Only plain JSON crosses back from the page. Some WebKit versions throw
  // on a DOM node ("unsupported type"), others pass it, so make it the
  // same everywhere: a node is true, undefined is null, and anything else
  // goes through JSON.
  const plain = (v: string) =>
    `(${v}) instanceof Node || (${v}) instanceof NodeList ? true : (${v}) === undefined ? null : JSON.parse(JSON.stringify(${v}))`;
  /** The value of a page expression, as JSON. A DOM node comes back as true. */
  const js = <T = unknown>(expr: string) =>
    evalJs<T>(`const v = await (${expr}); return ${plain("v")};`);

  /**
   * Wait until a page expression is truthy; return its value. Polls in the
   * page on timers (not frames, which stop while the window is hidden).
   * A reload (hot reload, or the page navigating) ends the poll in the old
   * page, so the wait starts again in the new one.
   */
  // The page load the last wait saw: performance.timeOrigin.
  let lastLoad: number | null = null;
  async function waitFor<T = unknown>(expr: string, ms = 5000): Promise<T> {
    const end = performance.now() + ms;
    for (;;) {
      const left = Math.max(0, Math.round(end - performance.now()));
      let v: { ok: boolean; v: T; load: number };
      try {
        v = await evalJs<{ ok: boolean; v: T; load: number }>(`
          const end = performance.now() + ${left};
          const load = performance.timeOrigin;
          for (;;) {
            let v; try { v = await (${expr}); } catch { v = undefined; }
            if (v) return { ok: true, v: ${plain("v")}, load };
            if (performance.now() > end) return { ok: false, v: null, load };
            await new Promise((r) => setTimeout(r, 10));
          }`);
      } catch (e) {
        // A failed call on the page the last wait saw: a real error, like
        // bad syntax. On a new page, try once more to tell which it is.
        const now = await evalJs<number>(
          "return performance.timeOrigin;",
        ).catch(() => null);
        if (now !== null && now === lastLoad) throw e;
        if (now !== null) lastLoad = now;
        if (performance.now() > end) throw e;
        await Bun.sleep(10);
        continue;
      }
      lastLoad = v.load;
      if (!v.ok)
        throw new Error(`timed out after ${ms} ms waiting for ${expr}`);
      return v.v;
    }
  }

  const readLog = async () =>
    (await Bun.file(s.log).exists()) ? Bun.file(s.log).text() : "";

  /** Wait for a log line (the shell's, or the core's in a tab) that matches `re`. */
  async function waitLog(re: RegExp, ms = 5000): Promise<RegExpMatchArray> {
    const end = Date.now() + ms;
    for (;;) {
      const m = (await readLog()).match(re);
      if (m) return m;
      if (Date.now() > end)
        throw new Error(`timed out after ${ms} ms waiting for log ${re}`);
      await Bun.sleep(20);
    }
  }

  /** Wait until the app's page (not about:blank) shows `sel`. */
  async function waitPage(sel = ready, extra = "true") {
    // Until the page loads, eval runs in about:blank or fails: retry.
    // readyState is "complete" only after the page's module scripts run
    // ("interactive" comes before them), so `ready` can name static HTML
    // and a click still finds its handler.
    const end = Date.now() + 20_000;
    for (;;) {
      try {
        const ok = await js<boolean>(
          `location.protocol !== "about:" && document.readyState === "complete" && ${native ? "!!window.__steambun" : "true"} && ${extra} && !!document.querySelector(${JSON.stringify(sel)})`,
        );
        if (ok) return;
      } catch {
        // The page is mid-load; try again.
      }
      if (Date.now() > end)
        throw new Error(`page never showed ${sel}\n${await readLog()}`);
      await Bun.sleep(25);
    }
  }

  async function start() {
    try {
      if (opts.front === false) return;
      if (native) await call("activate"); // frames and focus need the window in front
      await waitPage();
    } catch (e) {
      const log = await readLog();
      await s.stop();
      throw new Error(`${(e as Error).message}\n--- log ---\n${log}`, {
        cause: e,
      });
    }
  }

  const sel = (q: string) => JSON.stringify(q);

  /**
   * Click an element (its center, once it shows) or a page point, with a
   * real mouse event. Native: through AppKit, so hit-testing and drag
   * regions apply.
   */
  async function click(
    target: string | { x: number; y: number },
    o: ClickOpts = {},
  ) {
    let p = target;
    if (typeof p === "string") {
      p = await waitFor<{ x: number; y: number }>(`(() => {
        const e = document.querySelector(${sel(p)});
        if (!e) return null;
        e.scrollIntoView({ block: "nearest", inline: "nearest" });
        const r = e.getBoundingClientRect();
        return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
      })()`);
    }
    await s.click(p.x, p.y, o);
  }

  /** An element's text as shown (innerText), once it exists. */
  const text = (q: string, ms?: number) =>
    waitFor<string>(
      `(() => { const e = document.querySelector(${sel(q)}); return e ? [e.innerText.trim()] : null; })()`,
      ms,
    ).then((v) => (v as unknown as string[])[0]!);

  /** The page as a PNG. With a path, also write it there. */
  async function screenshot(path?: string) {
    const png = await s.screenshot();
    if (path) await Bun.write(path, png);
    return png;
  }

  /**
   * Each match's box (CSS px, to 0.5) and computed styles: numbers to
   * compare before and after a change. `styles` replaces the default list.
   */
  const layout = async (q: string, styles = LAYOUT_STYLES) =>
    // The shell's JSON has no key order: fix it, so two dumps diff cleanly.
    (
      await js<Box[]>(`[...document.querySelectorAll(${sel(q)})].map((e) => {
      const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
      const h = (n) => Math.round(n * 2) / 2;
      return {
        tag: e.tagName.toLowerCase(),
        // Skip scoped classes (svelte-abc123): they name nothing.
        name: e.id ? "#" + e.id : [...e.classList].filter((k) => !/^svelte-/.test(k)).map((k) => "." + k)[0] ?? "",
        text: (e.innerText ?? "").trim().replace(/\\s+/g, " ").slice(0, 40),
        x: h(r.x), y: h(r.y), w: h(r.width), h: h(r.height),
        style: Object.fromEntries(${JSON.stringify(styles)}.map((k) => [k, cs.getPropertyValue(k)])),
      };
    })`)
    ).map(({ tag, name, text: shown, x, y, w, h, style }) => ({
      tag,
      name,
      text: shown,
      x,
      y,
      w,
      h,
      style: Object.fromEntries(styles.map((k) => [k, style[k] ?? ""])),
    }));

  /**
   * Save a screenshot, the page's HTML and the logs to
   * <out>/test-failures/<name>/. Returns the folder. `test` from this
   * module calls it when a test fails.
   */
  async function saveFailure(name: string) {
    const slug = name
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80);
    const dir = join(c.root, c.out, "test-failures", slug || "test");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const tasks: Promise<unknown>[] = [
      readLog().then((l) => Bun.write(join(dir, "app.log"), l)),
      s.screenshot().then((p) => Bun.write(join(dir, "screenshot.png"), p)),
      js<string>("document.documentElement.outerHTML").then((h) =>
        Bun.write(join(dir, "page.html"), h),
      ),
    ];
    for (const f of ["page.log", "core.log"]) {
      const p = join(home, f);
      if (p !== s.log && existsSync(p))
        tasks.push(Bun.write(join(dir, f), Bun.file(p)));
    }
    // A hung page shouldn't hang the report: take what comes in 3 s.
    await Promise.race([Promise.allSettled(tasks), Bun.sleep(3000)]);
    return dir;
  }

  async function close() {
    open.delete(self);
    await s.stop();
    ports.delete(home);
    rmSync(home, { recursive: true, force: true });
    // WebKit keeps an identified store here. Deleting it while no process
    // uses it is safe; WebKit makes a new one if the id comes back.
    if (native)
      rmSync(
        join(homedir(), "Library/WebKit", c.id, "WebsiteDataStore", store),
        { recursive: true, force: true },
      );
  }

  const self = {
    /** Wait for the page; on failure, stop and throw with the log. */
    start,
    /** native or tab. */
    backend,
    /** True in the shell: menus, system state and paste work. */
    native,
    /** The app's resolved config. */
    config: c,
    home,
    call,
    eval: evalJs,
    js,
    waitFor,
    waitPage,
    waitLog,
    readLog,
    close,
    /** Quit and start again on the same home and web store. */
    async relaunch() {
      await s.stop();
      s = native
        ? await startNative(c, opts, home, store)
        : await startTab(c, opts, home);
      await start();
    },
    /** Go to a route the way a link in the app does. */
    go: (path: string) =>
      js(
        `(history.pushState(null, "", ${JSON.stringify(path)}), dispatchEvent(new PopStateEvent("popstate")), 1)`,
      ),
    /** Reload the page and wait for it to come back. */
    async reload(q = ready) {
      await js(
        "(window.__steambunTestGen = 1, setTimeout(() => location.reload()), 1)",
      );
      await waitPage(q, "!window.__steambunTestGen");
    },
    /** A chord like "mod+k" or "shift+Enter". Native: through the menus first. */
    key: (chord: string) => s.key(chord),
    type: (chars: string) => s.type(chars),
    click,
    text,
    screenshot,
    layout,
    saveFailure,
    paste: (clip: string) => call("paste", { text: clip }),
    /** Pretend the Mac slept, woke, lost the network or entered Low Power. */
    system: (st: TestArgs<"system">) => call("system", st),
    menu: (id: string) => call("menu", { id }),
    menuKey: (id: string) => call("menuKey", { id }),
    state: () => call("state"),
    /** Wait until the shell's state passes `ok`, for example a menu bar title. */
    async until(ok: (s: TestResult<"state">) => boolean, ms = 3000) {
      const end = Date.now() + ms;
      for (;;) {
        const st = await call("state");
        if (ok(st)) return st;
        if (Date.now() > end)
          throw new Error(`state never matched: ${JSON.stringify(st)}`);
        await Bun.sleep(30);
      }
    },
    activate: () => call("activate"),
    /** The focused element: its placeholder, or its tag name. */
    focused: () =>
      js<string>(
        "document.activeElement?.placeholder || document.activeElement?.tagName",
      ),
    /**
     * Write settings as the page does: to the core if there is one, else to
     * localStorage. Null deletes. Reload to make the page read them.
     */
    settings: (st: Record<string, string | null>) =>
      c.core
        ? js(
            `fetch("/_steambun/settings", { method: "PUT", body: ${JSON.stringify(JSON.stringify(st))} }).then((r) => r.status)`,
          )
        : js(
            `(Object.entries(${JSON.stringify(st)}).forEach(([k, v]) => v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v)), 200)`,
          ),
  };
  return self;
}

// MARK: native

/**
 * The page server's port, per home. A relaunch reuses it: localStorage
 * belongs to the origin, so a new port would look like a new app.
 */
const ports = new Map<string, number>();

/** A port nothing listens on now, from the kernel. */
function freePort() {
  const s = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = s.port;
  s.stop(true);
  return port;
}

async function startNative(
  c: Resolved,
  o: LaunchOpts,
  home: string,
  store: string,
): Promise<Session> {
  const { shell } = paths(c);
  const log = join(home, "native.log");
  rmSync(log, { force: true });

  // The shell's end of the link.
  let sock: ServerWebSocket<unknown> | null = null;
  let linked!: () => void;
  const linkedP = new Promise<void>((r) => (linked = r));
  let seq = 0;
  const calls = new Map<number, Call>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, s) =>
      s.upgrade(req) ? undefined : new Response("no", { status: 400 }),
    websocket: {
      open(ws) {
        sock = ws;
        linked();
      },
      message(_ws, m) {
        const r = JSON.parse(String(m));
        const pending = calls.get(r.id);
        if (!pending) return;
        calls.delete(r.id);
        if (r.ok) pending.resolve(r.result);
        else pending.reject(new Error(`${pending.op}: ${r.error}`));
      },
      close() {
        sock = null;
        for (const pending of calls.values())
          pending.reject(new Error(`${pending.op}: shell went away`));
        calls.clear();
      },
    },
  });

  const env: Record<string, string> = {
    ...(Bun.env as Record<string, string>),
    ...o.env,
    STEAMBUN_TEST_WS: `ws://127.0.0.1:${server.port}/`,
    STEAMBUN_STORE: store,
  };
  let page: Subprocess | null = null;
  if (c.core && !o.env?.STEAMBUN_PORT) {
    // Never the app's own port: two launches at once (test files run in
    // parallel) would both see it free and race for it. relaunch() keeps
    // this one, so the origin, and the page's storage, stay the same.
    if (!ports.has(home)) ports.set(home, freePort());
    env.STEAMBUN_PORT = String(ports.get(home));
  }
  if (!builtOf(o)) {
    if (c.core) {
      // The shell runs STEAMBUN_CORE as the core: point it at the source.
      const core = join(home, "core.sh");
      await Bun.write(
        core,
        `#!/bin/sh\ncd ${q(c.root)} && exec bun${o.hot ? " --hot" : ""} ${q(join(c.root, c.core))} ${(o.args ?? []).map(q).join(" ")} "$@"\n`,
      );
      chmodSync(core, 0o755);
      env.STEAMBUN_CORE = core;
    } else if (!o.url) {
      // No core: the page's dev server, and the shell pointed at it.
      const p = Bun.spawn(
        [
          "bun",
          ...(o.hot ? ["--hot"] : []),
          join(FW, "devpage.ts"),
          join(c.root, c.page),
        ],
        {
          cwd: c.root,
          env: {
            ...env,
            STEAMBUN_PORT: String(ports.get(home) ?? 0),
            STEAMBUN_PARENT_PID: String(process.pid),
          },
          stdout: "pipe",
          stderr: Bun.file(join(home, "page.log")),
        },
      );
      page = p;
      const port = await readyPort(p);
      ports.set(home, port);
      env.STEAMBUN_URL = `http://127.0.0.1:${port}/`;
    }
  }
  if (o.url) env.STEAMBUN_URL = o.url;
  const proc = Bun.spawn(
    [shell, "-STEAMBUN_HOME", home, "-STEAMBUN_LOG", log],
    {
      env,
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  const stop = async () => {
    proc.kill();
    await proc.exited;
    page?.kill();
    await page?.exited;
    server.stop(true);
  };
  try {
    await Promise.race([
      linkedP,
      proc.exited.then((code) => {
        throw new Error(`the shell exited (${code}) before it linked`);
      }),
      Bun.sleep(10_000).then(() => {
        throw new Error("the shell never linked to the harness");
      }),
    ]);
  } catch (e) {
    const text = (await Bun.file(log).exists())
      ? await Bun.file(log).text()
      : "";
    await stop();
    throw new Error(`${(e as Error).message}\n--- log ---\n${text}`, {
      cause: e,
    });
  }

  function call<K extends TestOp>(
    op: K,
    args?: TestArgs<K>,
  ): Promise<TestResult<K>> {
    if (!sock) return Promise.reject(new Error(`${op}: shell not linked`));
    const id = ++seq;
    const p = new Promise<unknown>((ok, fail) =>
      calls.set(id, { resolve: ok, reject: fail, op }),
    );
    sock.send(JSON.stringify({ id, op, args: args ?? {} }));
    return p as Promise<TestResult<K>>;
  }
  return {
    call,
    eval: <T>(js: string) => call("eval", { js }) as Promise<T>,
    key: (chord) => call("key", { chord }),
    type: (text) => call("type", { text }),
    click: (x, y, how) =>
      call("click", { x, y, count: how.count, mods: how.mods }),
    screenshot: async () =>
      new Uint8Array(Buffer.from(await call("screenshot"), "base64")),
    log,
    stop,
  };
}

// MARK: tab

async function startTab(
  c: Resolved,
  o: LaunchOpts,
  home: string,
): Promise<Session> {
  const log = join(home, "core.log");
  const entry = c.core
    ? [join(c.root, c.core), ...(o.args ?? [])]
    : [join(FW, "devpage.ts"), join(c.root, c.page)];
  const p = Bun.spawn(["bun", ...(o.hot ? ["--hot"] : []), ...entry], {
    cwd: c.root,
    env: {
      ...(Bun.env as Record<string, string>),
      ...o.env,
      STEAMBUN_HOME: home,
      STEAMBUN_PORT: String(ports.get(home) ?? 0),
      STEAMBUN_PARENT_PID: String(process.pid),
    },
    stdout: "pipe",
    stderr: Bun.file(log),
  });
  let port: number;
  try {
    port = await readyPort(p);
    ports.set(home, port);
  } catch (e) {
    p.kill();
    const text = (await Bun.file(log).exists())
      ? await Bun.file(log).text()
      : "";
    throw new Error(`${(e as Error).message}\n--- log ---\n${text}`, {
      cause: e,
    });
  }
  // The view's data lives in the home, so each launch starts clean and
  // relaunch() keeps it.
  // A menu bar app's page lives in its panel: use the panel's size.
  const box = c.menuBar || c.window;
  const view = new Bun.WebView({
    width: o.size?.width ?? box.width,
    height: o.size?.height ?? box.height,
    dataStore: { directory: join(home, "webview") },
  });
  await view.navigate(o.url ?? `http://127.0.0.1:${port}/`);
  const ev = <T>(js: string) => view.evaluate(js) as Promise<T>;
  return {
    // A function body, as in the shell: run it, await it, return its value.
    eval: <T>(body: string) => ev<T>(`(async () => { ${body} })()`),
    async key(chord) {
      const { key, mods } = parseChord(chord);
      await view.press(key, mods.length > 0 ? { modifiers: mods } : undefined);
    },
    async type(text) {
      // The shell types "\r" as Return; do the same.
      for (const [i, part] of text.split("\r").entries()) {
        if (i) await view.press("Enter");
        if (part) await view.type(part);
      }
    },
    click: (x, y, how) =>
      view.click(x, y, {
        clickCount: how.count,
        modifiers: how.mods?.map(
          (m) =>
            ({ shift: "Shift", ctrl: "Control", alt: "Alt", meta: "Meta" })[
              m
            ] as Mod,
        ),
      }),
    screenshot: async () =>
      new Uint8Array(await view.screenshot({ encoding: "buffer" })),
    log,
    async stop() {
      view.close();
      p.kill();
      await p.exited;
    },
  };
}

type Mod = "Meta" | "Control" | "Alt" | "Shift";

/** "mod+shift+k" → key "k" with Meta and Shift, as the shell reads it. */
export function parseChord(chord: string): { key: string; mods: Mod[] } {
  const parts = chord.endsWith("++")
    ? [...chord.slice(0, -2).split("+"), "+"]
    : chord.split("+");
  const key = parts.pop()!;
  const map: Record<string, Mod> = {
    mod: "Meta",
    cmd: "Meta",
    ctrl: "Control",
    alt: "Alt",
    opt: "Alt",
    shift: "Shift",
  };
  const mods = parts.map((m) => {
    const v = map[m.toLowerCase()];
    if (!v) throw new Error(`bad modifier ${m} in ${chord}`);
    return v;
  });
  return { key, mods };
}

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** The port from a child's `STEAMBUN_READY <port>` line. */
async function readyPort(p: {
  stdout: ReadableStream<Uint8Array>;
}): Promise<number> {
  const reader = p.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const end = Date.now() + 20_000;
  for (;;) {
    const r = await Promise.race([
      reader.read(),
      Bun.sleep(end - Date.now()).then(() => null),
    ]);
    if (!r)
      throw new Error("the core or page server never said STEAMBUN_READY");
    if (r.done)
      throw new Error("the core or page server exited before it was ready");
    buf += dec.decode(r.value, { stream: true });
    const m = buf.match(/STEAMBUN_READY (\d+)/);
    if (!m) continue;
    // Keep draining so a full pipe never blocks the child.
    (async () => {
      while (!(await reader.read()).done);
    })();
    return Number(m[1]);
  }
}
