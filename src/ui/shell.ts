// The page's half of the native window: drag areas, the right-click guard
// and the first-paint report. In the shell's boot script these would be
// Swift strings; here they hot-reload like any page code.
//
// It starts on its own when the page imports steambun/ui, with the
// defaults. Call startShell(opts) only to change them:
//
//   const stop = startShell({ paint: ".list .row" });
//
//   - window drag: the title bar band (--shell-titlebar) and [data-drag]
//   - double-click there: zoom, like a native title bar
//   - right-click: WebKit's menu only where it offers something (text
//     fields, links, a selection)
//   - first paint: the first `paint` element, once per page load, for
//     launch timing (bench/paint.ts)
//
// The title bar padding is CSS: `html[data-shell=mac]`. No-op outside the
// shell. Returns a stop function for hot reload.
import { native } from "./native.ts";

export interface ShellOptions {
  /** Clicks here keep their meaning inside a drag area. Added to the defaults. */
  controls?: string;
  /** The title bar band doesn't drag over these (drawers, dialogs). */
  noBand?: string;
  /** Right-click shows WebKit's menu over these too (a terminal). */
  contextMenu?: string;
  /** Report first paint when this appears. False: don't. Default: any element in body but a script. */
  paint?: string | false;
}

// Controls inside a drag area keep their clicks; header text stays
// selectable. WKWebView has no -webkit-app-region, so the page decides and
// the shell moves the window.
const CONTROLS =
  "a, button, input, textarea, select, label, summary, [role=button], [role=tab], [role=radio], [contenteditable], [data-no-drag]";

function titlebar(): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue(
    "--shell-titlebar",
  );
  return parseFloat(v) || 0;
}

function onMouseDown(this: Required<ShellOptions>, e: MouseEvent) {
  if (e.button !== 0 || !(e.target instanceof Element)) return;
  if (e.target.closest(this.controls)) return;
  const band = e.clientY < titlebar() && !e.target.closest(this.noBand);
  if (!band && !e.target.hasAttribute("data-drag")) return;
  e.preventDefault();
  native.send(e.detail === 2 ? "window.zoom" : "window.drag");
}

function onContextMenu(this: Required<ShellOptions>, e: MouseEvent) {
  const t = e.target instanceof Element ? e.target : null;
  if (t?.closest(this.contextMenu)) return;
  if (String(getSelection() ?? "").trim()) return;
  e.preventDefault();
}

/** Watch for the first paint of `sel`. Returns a cancel function. */
function watchPaint(sel: string): () => void {
  let cancelled = false;
  const seen = () => !!document.querySelector(sel);
  // Two frames after the rows land is when they're on screen. A window that
  // gets no frames (behind others, screen locked) can still say "visible",
  // so a timer backs the frames up and reports when the rows hit the DOM.
  const report = () => {
    const inDom = performance.now();
    let sent = false;
    const send = (ms: number) => {
      if (sent || cancelled) return;
      sent = true;
      w.__steambunPainted = true;
      // WebKit's paint of anything at all: often before the rows.
      const fcp = performance.getEntriesByName("first-contentful-paint")[0];
      native.send("app.paint", { ms, fcp: fcp?.startTime });
    };
    requestAnimationFrame(() =>
      requestAnimationFrame(() => send(performance.now())),
    );
    setTimeout(
      () => send(inDom),
      document.visibilityState === "hidden" ? 0 : 500,
    );
  };
  if (seen()) {
    report();
    return () => {
      cancelled = true;
    };
  }
  const mo = new MutationObserver(() => {
    if (!seen()) return;
    mo.disconnect();
    report();
  });
  mo.observe(document.body, { childList: true, subtree: true });
  return () => {
    cancelled = true;
    mo.disconnect();
  };
}

const w = globalThis as { __steambunPainted?: boolean };

/** The glue started on import, until the app calls startShell itself. */
let auto: (() => void) | null = null;

/**
 * Start the shell glue with your own options, in place of the defaults it
 * started with. Call again after a hot reload; stop the old one first.
 */
export function startShell(opts: ShellOptions = {}): () => void {
  auto?.();
  auto = null;
  return start(opts);
}

function start(opts: ShellOptions): () => void {
  if (!native.inShell) return () => {};
  const o: Required<ShellOptions> = {
    controls: opts.controls ? `${CONTROLS}, ${opts.controls}` : CONTROLS,
    noBand: opts.noBand ? `[role=dialog], ${opts.noBand}` : "[role=dialog]",
    contextMenu: `input, textarea, [contenteditable], a[href]${opts.contextMenu ? `, ${opts.contextMenu}` : ""}`,
    paint: opts.paint ?? "body > :not(script)",
  };
  const down = onMouseDown.bind(o);
  const menu = onContextMenu.bind(o);
  addEventListener("mousedown", down, true);
  addEventListener("contextmenu", menu);
  // Once per page load, not per hot reload: the flag lives on window.
  const stopPaint =
    o.paint && !w.__steambunPainted ? watchPaint(o.paint) : () => {};
  return () => {
    stopPaint();
    removeEventListener("mousedown", down, true);
    removeEventListener("contextmenu", menu);
  };
}

// Start with the defaults. An app that calls startShell(opts) replaces
// them, and its paint selector wins if its call comes before the default
// one fires. The default ignores scripts, so an empty body doesn't count.
auto = start({});
