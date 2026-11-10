// One interface for a browser page the core can drive, with two backends:
//
//   HeadlessPage  Bun.WebView: off screen, streamed to the tab as frames.
//                 Works in any browser tab, in tests and with no window.
//   NativePage    a real WKWebView in the native shell, over the pane
//                 (link.ts). Full fidelity: hover, drag, selection.
//
// Tests and agents call the same methods on either.

export type Mod = "shift" | "ctrl" | "alt" | "meta";
export interface Meta {
  url: string;
  title: string;
  loading: boolean;
}
export interface LogEntry {
  t: number;
  level: "log" | "info" | "warn" | "error" | "debug" | "net";
  text: string;
}

export interface Page {
  readonly kind: "headless" | "native";
  /** Resolves when the page exists (native: the shell made the view). */
  readonly ready: Promise<void>;
  meta(): Meta;
  onMeta: ((m: Meta) => void) | null;
  onLog: ((e: LogEntry[]) => void) | null;
  onError: ((message: string) => void) | null;
  navigate(url: string): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  /** An expression, awaited in the page; the result comes back as JSON. */
  evaluate<T = unknown>(expr: string): Promise<T>;
  screenshot(format?: "jpeg" | "png", quality?: number): Promise<Uint8Array>;
  click(
    x: number,
    y: number,
    o?: { count?: number; mods?: Mod[] },
  ): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string, mods?: Mod[]): Promise<void>;
  scroll(dx: number, dy: number): Promise<void>;
  resize(w: number, h: number): Promise<void>;
  /** Console output, page errors and requests, newest last. */
  logs(): Promise<LogEntry[]>;
  close(): void;
}

const RING = 500;

/** Keep the newest RING entries; tell the listener about the new ones. */
export function addLogs(p: Page, ring: LogEntry[], add: LogEntry[]) {
  if (add.length === 0) return;
  ring.push(...add);
  if (ring.length > RING) ring.splice(0, ring.length - RING);
  p.onLog?.(add);
}

/**
 * Console, error and request capture. The native shell injects it before
 * any page script runs; the headless page gets it after each navigation, so
 * it misses output from the first moments of a load. Entries wait in
 * window.__steambunLog until drained; in the native shell they are also posted
 * as they happen.
 */
export const PROBE = `(() => {
  if (window.__steambunLog) return;
  const buf = (window.__steambunLog = []);
  const sink = window.webkit?.messageHandlers?.steambunLog;
  const push = (level, text) => {
    const e = { t: Date.now(), level, text: String(text).slice(0, 4000) };
    if (sink) return sink.postMessage(e);
    buf.push(e);
    if (buf.length > ${RING}) buf.shift();
  };
  const fmt = (a) => a.map((x) => {
    if (typeof x === "string") return x;
    if (x instanceof Error) return x.stack || String(x);
    try { return JSON.stringify(x) ?? String(x); } catch { return String(x); }
  }).join(" ");
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const orig = console[level].bind(console);
    console[level] = (...a) => { push(level, fmt(a)); orig(...a); };
  }
  addEventListener("error", (e) => push("error", e.error?.stack || e.message));
  addEventListener("unhandledrejection", (e) => push("error", "Unhandled rejection: " + fmt([e.reason])));
  try {
    new PerformanceObserver((l) => {
      for (const r of l.getEntries())
        push("net", (r.responseStatus || "") + " " + r.initiatorType + " " + r.name + " " + Math.round(r.duration) + " ms");
    }).observe({ type: "resource", buffered: true });
  } catch {}
})()`;

const DRAIN = "(window.__steambunLog || []).splice(0)";

const BUN_MODS: Record<Mod, Bun.WebView.Modifier> = {
  shift: "Shift",
  ctrl: "Control",
  alt: "Alt",
  meta: "Meta",
};

export class HeadlessPage implements Page {
  readonly kind = "headless";
  readonly ready = Promise.resolve();
  readonly view: Bun.WebView;
  onMeta: ((m: Meta) => void) | null = null;
  onLog: ((e: LogEntry[]) => void) | null = null;
  onError: ((message: string) => void) | null = null;
  private ring: LogEntry[] = [];
  // Bun.WebView allows one evaluate at a time.
  private evalQ: Promise<unknown> = Promise.resolve();

  constructor(o: { width: number; height: number; dataDir: string }) {
    this.view = new Bun.WebView({
      width: o.width,
      height: o.height,
      // Cookies and logins survive restarts, like a normal browser profile.
      dataStore: { directory: o.dataDir },
    });
    this.view.onNavigated = () => {
      this.onMeta?.(this.meta());
      this.evaluate(PROBE).catch(() => {});
    };
    this.view.onNavigationFailed = (e) => {
      this.onMeta?.(this.meta());
      this.onError?.(e.message);
    };
  }

  meta(): Meta {
    const v = this.view;
    return { url: v.url, title: v.title, loading: v.loading };
  }
  private after<T>(p: Promise<T>) {
    return p.finally(() => this.onMeta?.(this.meta()));
  }
  navigate(url: string) {
    return this.after(this.view.navigate(url));
  }
  back() {
    return this.after(this.view.goBack());
  }
  forward() {
    return this.after(this.view.goForward());
  }
  reload() {
    return this.after(this.view.reload());
  }
  evaluate<T = unknown>(expr: string): Promise<T> {
    const p = this.evalQ.then(() => this.view.evaluate<T>(expr));
    this.evalQ = p.catch(() => {});
    return p;
  }
  async screenshot(format: "jpeg" | "png" = "png", quality = 80) {
    return this.view.screenshot({ format, quality, encoding: "buffer" });
  }
  click(x: number, y: number, o: { count?: number; mods?: Mod[] } = {}) {
    const count = ([1, 2, 3] as const)[
      Math.max(0, Math.min(2, (o.count ?? 1) - 1))
    ];
    return this.view.click(x, y, {
      clickCount: count,
      modifiers: (o.mods ?? []).map((m) => BUN_MODS[m]),
    });
  }
  type(text: string) {
    return this.view.type(text);
  }
  press(key: string, mods: Mod[] = []) {
    return this.view.press(key, { modifiers: mods.map((m) => BUN_MODS[m]) });
  }
  scroll(dx: number, dy: number) {
    return this.view.scroll(dx, dy);
  }
  resize(w: number, h: number) {
    return this.view.resize(w, h);
  }
  async logs() {
    const add = await this.evaluate<LogEntry[]>(DRAIN).catch(() => []);
    addLogs(this, this.ring, Array.isArray(add) ? add : []);
    return this.ring.slice();
  }
  close() {
    this.view.close();
  }
}
