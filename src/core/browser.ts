// Browser panes: one session per pane id, backed by a Page (page.ts).
//
//   native    the native shell is linked: a real WKWebView sits over the
//             pane. The tab tells the shell where the pane is; the core
//             only relays commands and events.
//   headless  any other case: Bun.WebView off screen, streamed to the tab
//             as JPEG frames. The tab sends clicks, keys and wheel deltas.
//
// Agents and tests drive the same sessions through POST /_steambun/browser
// (see `api` below).
//
// Wire format on the socket:
//   server → tab   binary: one JPEG frame (headless only).
//                  text: {"type":"kind","kind"} | {"type":"meta","url","title","loading"}
//                  | {"type":"log","entries"} | {"type":"error","message"}
//   tab → server   text: {"type":"size","w","h"} | {"type":"nav","url"}
//                  | {"type":"click","x","y","count","mods"}
//                  | {"type":"text","s"} | {"type":"key","key","mods"}
//                  | {"type":"scroll","dx","dy"} | {"type":"back"|"forward"|"reload"}
//
// Frames: Bun.WebView can't say when its pixels change, so the core takes a
// screenshot on a timer and sends it only if the bytes changed. The timer
// runs fast (FAST_MS) for HOT_MS after any input or navigation, slow
// (SLOW_MS) otherwise, and not at all when no tab is attached. A tab that
// falls LAG_MAX behind skips frames.

import type { ServerWebSocket } from "bun";
import { home } from "./home.ts";
import { NativePage, setOnUnlink, waitLinked } from "./link.ts";
import { detail, log } from "./log.ts";
import { HeadlessPage, type LogEntry, type Mod, type Page } from "./page.ts";

export interface BrowserData {
  steambun: "browser";
  browser: string;
  native?: boolean;
}
type Sock = ServerWebSocket<BrowserData>;

interface Session {
  key: string;
  page: Page;
  socks: Set<Sock>;
  size: { w: number; h: number };
  // Input runs one at a time, in order.
  queue: Promise<unknown>;
  // Fast frames until this time.
  hotUntil: number;
  timer: Timer | null;
  // A capture is in flight; `again` asks for another right after it.
  capturing: boolean;
  again: boolean;
  lastHash: number | bigint;
  // Wheel deltas waiting for the scroll in flight to finish.
  wheel: { dx: number; dy: number; busy: boolean };
  detachedAt: number;
  // For the stats line: frames sent, and capture time.
  frames: number;
  captureMs: number;
}

const FAST_MS = 33;
const SLOW_MS = 500;
const HOT_MS = 1500;
const LAG_MAX = 1024 * 1024;
const MAX_VIEWS = 2;
const IDLE_MS = 5 * 60_000;
const QUALITY = 70;
const DRAIN_MS = 1000;

const g = globalThis as {
  __steambunBrowsers?: Map<string, Session>;
  __steambunBrowserReap?: Timer;
};
const sessions = (g.__steambunBrowsers ??= new Map<string, Session>());
// Sessions still being made (a native one waits for the shell).
const opening = new Map<string, Promise<Session>>();

/** A URL from what the user typed: a host gets http or https, words search. */
function toUrl(typed: string): string {
  const s = typed.trim();
  if (/^(https?|data|about):/i.test(s)) return s;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(s))
    return `http://${s}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(s)) return `https://${s}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`;
}

function send(s: Session, m: object) {
  const text = JSON.stringify(m);
  for (const ws of s.socks) ws.send(text);
}

function heat(s: Session) {
  if (s.page.kind !== "headless") return;
  s.hotUntil = performance.now() + HOT_MS;
  // Take the next frame now rather than at the end of a wait. If a capture
  // is running, it may predate the input: take one more right after it.
  if (s.capturing) s.again = true;
  else if (s.timer) {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => frame(s), 0);
  }
}

async function frame(s: Session) {
  s.timer = null;
  if (s.socks.size === 0 || !sessions.has(s.key)) return;
  const t0 = performance.now();
  s.capturing = true;
  s.again = false;
  try {
    const jpeg = await s.page.screenshot("jpeg", QUALITY);
    s.captureMs += performance.now() - t0;
    const h = Bun.hash(jpeg);
    if (h !== s.lastHash) {
      s.lastHash = h;
      s.frames++;
      for (const ws of s.socks)
        if (ws.getBufferedAmount() < LAG_MAX) ws.sendBinary(jpeg);
    }
  } catch (e) {
    if (!sessions.has(s.key)) return;
    log("browser", `${s.key}: screenshot failed: ${(e as Error).message}`);
  }
  s.capturing = false;
  if (s.socks.size === 0) return;
  const hot = performance.now() < s.hotUntil;
  let wait = hot ? FAST_MS : SLOW_MS;
  if (s.again) wait = 0;
  s.timer = setTimeout(() => frame(s), wait);
}

/** Run input in order; the result goes to the caller, errors to the log too. */
function run<T>(s: Session, f: () => Promise<T>): Promise<T> {
  const p = s.queue.then(f);
  s.queue = p.catch((e) => log("browser", `${s.key}: ${(e as Error).message}`));
  s.queue.then(() => heat(s));
  heat(s);
  return p;
}

function make(key: string, native: boolean): Session {
  const page: Page = native
    ? new NativePage(key)
    : new HeadlessPage({
        width: 1024,
        height: 768,
        dataDir: home("browser"),
      });
  const s: Session = {
    key,
    page,
    socks: new Set(),
    size: { w: 1024, h: 768 },
    queue: Promise.resolve(),
    hotUntil: 0,
    timer: null,
    capturing: false,
    again: false,
    lastHash: 0,
    wheel: { dx: 0, dy: 0, busy: false },
    detachedAt: Date.now(),
    frames: 0,
    captureMs: 0,
  };
  page.onMeta = (m) => send(s, { type: "meta", ...m });
  page.onError = (message) => send(s, { type: "error", message });
  page.onLog = (entries) => send(s, { type: "log", entries });
  sessions.set(key, s);
  detail("browser", `${key}: opened (${page.kind})`);
  // Keep at most MAX_VIEWS headless views: close the one detached longest.
  const idle = [...sessions.values()].filter(
    (x) => x.socks.size === 0 && x !== s && x.page.kind === "headless",
  );
  const headless = [...sessions.values()].filter(
    (x) => x.page.kind === "headless",
  ).length;
  idle.sort((a, b) => a.detachedAt - b.detachedAt);
  for (const x of idle.slice(0, Math.max(0, headless - MAX_VIEWS)))
    close(x, "too many views");
  return s;
}

/**
 * The session for `key`. A new one is native when asked for and the shell
 * links in time, headless otherwise. An existing one keeps its kind,
 * unless a native tab finds a headless one nobody is watching.
 */
async function session(key: string, native?: boolean): Promise<Session> {
  const have = sessions.get(key);
  if (
    have &&
    !(native && have.page.kind === "headless" && have.socks.size === 0)
  )
    return have;
  const busy = opening.get(key);
  if (busy) return busy;
  const p = (async () => {
    // The shell links just after the core starts; give it a moment.
    const linked = native !== false && (await waitLinked(native ? 3000 : 0));
    const cur = sessions.get(key);
    if (cur) {
      if (!(linked && cur.page.kind === "headless" && cur.socks.size === 0))
        return cur;
      close(cur, "native shell linked");
    }
    const s = make(key, linked);
    await s.page.ready;
    return s;
  })().finally(() => opening.delete(key));
  opening.set(key, p);
  return p;
}

function close(s: Session, why: string) {
  detail("browser", `${s.key}: closed (${why}), ${s.frames} frames`);
  sessions.delete(s.key);
  if (s.timer) clearTimeout(s.timer);
  s.page.close();
}

// Pages that died with the shell: close their tabs, which then reconnect
// and get a headless page.
setOnUnlink((ids) => {
  for (const id of ids) {
    const s = sessions.get(id);
    if (!s) continue;
    sessions.delete(id);
    if (s.timer) clearTimeout(s.timer);
    for (const ws of s.socks) ws.close(1012, "native shell gone");
  }
});

clearInterval(g.__steambunBrowserReap);
g.__steambunBrowserReap = setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    // Headless pages hold their console output until drained.
    if (s.socks.size > 0 && s.page.kind === "headless") s.page.logs();
    // Native pages live as long as the shell; they cost nothing hidden.
    if (
      s.page.kind === "headless" &&
      s.socks.size === 0 &&
      now - s.detachedAt > IDLE_MS
    )
      close(s, "idle");
  }
}, DRAIN_MS).unref();

const MODS: Mod[] = ["shift", "ctrl", "alt", "meta"];
const mods = (m: unknown): Mod[] =>
  Array.isArray(m) ? m.filter((x): x is Mod => MODS.includes(x)) : [];
const num = (n: unknown, max = 100_000) =>
  typeof n === "number" && Number.isFinite(n)
    ? Math.max(-max, Math.min(max, n))
    : 0;
const str = (v: unknown) => (typeof v === "string" ? v : "");

async function scroll(s: Session) {
  const w = s.wheel;
  if (w.busy || (!w.dx && !w.dy)) return;
  w.busy = true;
  const { dx, dy } = w;
  w.dx = w.dy = 0;
  try {
    await s.page.scroll(dx, dy);
  } finally {
    w.busy = false;
    heat(s);
    scroll(s);
  }
}

// Sockets whose session is still being made.
const pending = new WeakMap<Sock, Promise<Session | null>>();

export const browserSocket = {
  open(ws: Sock) {
    const p = session(ws.data.browser, !!ws.data.native).then(
      (s) => {
        if (ws.readyState !== 1) return null;
        s.socks.add(ws);
        s.lastHash = 0;
        ws.send(JSON.stringify({ type: "kind", kind: s.page.kind }));
        ws.send(JSON.stringify({ type: "meta", ...s.page.meta() }));
        s.page.logs().then((entries) => {
          if (entries.length > 0)
            ws.send(JSON.stringify({ type: "log", entries }));
        });
        if (s.page.kind === "headless") {
          heat(s);
          if (!s.timer) frame(s);
        }
        return s;
      },
      (e) => {
        log("browser", `${ws.data.browser}: ${(e as Error).message}`);
        ws.close(1011, "could not open page");
        return null;
      },
    );
    pending.set(ws, p);
  },
  async message(ws: Sock, raw: string | Buffer) {
    const s = await pending.get(ws);
    if (!s || typeof raw !== "string") return;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const v = s.page;
    const ignore = () => {};
    switch (m.type) {
      case "size": {
        // A native view takes its size from the pane it covers.
        if (v.kind === "native") return;
        const w = Math.round(num(m.w, 4000)),
          h = Math.round(num(m.h, 4000));
        if (w < 50 || h < 50 || (w === s.size.w && h === s.size.h)) return;
        s.size = { w, h };
        return void run(s, () => v.resize(w, h)).catch(ignore);
      }
      case "nav":
        if (!str(m.url)) return;
        return void run(s, () => v.navigate(toUrl(str(m.url)))).catch(ignore);
      case "click":
        return void run(s, () =>
          v.click(num(m.x), num(m.y), {
            count: num(m.count),
            mods: mods(m.mods),
          }),
        ).catch(ignore);
      case "text":
        if (!str(m.s)) return;
        return void run(s, () => v.type(str(m.s))).catch(ignore);
      case "key":
        if (!str(m.key)) return;
        return void run(s, () => v.press(str(m.key), mods(m.mods))).catch(
          ignore,
        );
      case "scroll":
        s.wheel.dx += num(m.dx);
        s.wheel.dy += num(m.dy);
        return void scroll(s);
      case "back":
        return void run(s, () => v.back()).catch(ignore);
      case "forward":
        return void run(s, () => v.forward()).catch(ignore);
      case "reload":
        return void run(s, () => v.reload()).catch(ignore);
    }
  },
  async close(ws: Sock) {
    const s = await pending.get(ws);
    if (!s) return;
    s.socks.delete(ws);
    if (s.socks.size > 0) return;
    s.detachedAt = Date.now();
    const sec = s.frames ? (s.captureMs / s.frames).toFixed(1) : "-";
    detail(
      "browser",
      `${s.key}: detached, ${s.frames} frames, ${sec} ms per capture`,
    );
  },
};

/**
 * POST /_steambun/browser/<op> with a JSON body: the agent and test interface.
 * `page` names the session (default "main", the pane in the app). A page
 * that doesn't exist yet opens native when the shell is linked.
 *
 *   open {url}            eval {expr}         shot {format?}  → image
 *   click {x,y}|{selector}  type {text}       press {key, mods?}
 *   scroll {dx,dy}        resize {w,h}        back  forward  reload
 *   logs                  info
 */
export async function api(op: string, b: Record<string, unknown>) {
  const s = await session(str(b.page) || "main");
  if (s.socks.size === 0) s.detachedAt = Date.now();
  const v = s.page;
  const json = (x: unknown) => Response.json(x ?? null);
  const ok = () => json({ ok: true, kind: v.kind, ...v.meta() });
  switch (op) {
    case "info":
      return ok();
    case "open":
      await run(s, () => v.navigate(toUrl(str(b.url))));
      return ok();
    case "back":
    case "forward":
    case "reload":
      await run(s, () => v[op]());
      return ok();
    case "eval":
      return json(await run(s, () => v.evaluate(str(b.expr))));
    case "shot": {
      const png = b.format !== "jpeg";
      const img = await run(s, () =>
        v.screenshot(png ? "png" : "jpeg", num(b.quality, 100) || 80),
      );
      return new Response(new Uint8Array(img), {
        headers: { "content-type": png ? "image/png" : "image/jpeg" },
      });
    }
    case "click": {
      let { x, y } = { x: num(b.x), y: num(b.y) };
      if (str(b.selector)) {
        // Scroll it into view and click its center, on either backend.
        const r = await run(s, () =>
          v.evaluate<{ x: number; y: number } | null>(
            `(() => { const el = document.querySelector(${JSON.stringify(b.selector)}); if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
          ),
        );
        if (!r) return json({ ok: false, error: "no element matches" });
        ({ x, y } = r);
      }
      await run(s, () =>
        v.click(x, y, { count: num(b.count) || 1, mods: mods(b.mods) }),
      );
      return ok();
    }
    case "type":
      await run(s, () => v.type(str(b.text)));
      return ok();
    case "press":
      await run(s, () => v.press(str(b.key), mods(b.mods)));
      return ok();
    case "scroll":
      await run(s, () => v.scroll(num(b.dx), num(b.dy)));
      return ok();
    case "resize":
      await run(s, () => v.resize(num(b.w, 4000), num(b.h, 4000)));
      return ok();
    case "logs": {
      const since = num(b.since, Number.MAX_SAFE_INTEGER);
      const all: LogEntry[] = await v.logs();
      return json(all.filter((e) => e.t > since));
    }
  }
  return new Response("unknown op", { status: 404 });
}
