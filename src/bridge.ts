// The framework's bridge: what every steambun shell does. One schema for
//
//   page → shell    ops    `native.call` runs them; the shell replies
//   shell → page    events the shell emits; `native.on` hears them
//   shell → core    events about the Mac (sleep, network, Low Power)
//   core → shell    page ops: drive a native browser page (core/link.ts)
//   test → shell    test ops: drive the whole app (test.ts). Only a shell
//                   launched with STEAMBUN_TEST_WS has them.
//
// `steambun gen` writes Bridge.gen.swift from this file: Codable structs, a
// protocol the shell implements, and exhaustive enums. Add an op here, and
// the Swift build fails until the shell handles it. `steambun gen --check`
// fails if the generated file is stale. Apps add ops in their own bridge file.
import { type Op, op, t, type Ty, ty, type V } from "./schema.ts";

const Rect = t.struct("BridgeRect", {
  x: t.number,
  y: t.number,
  w: t.number,
  h: t.number,
});
const Mods = t.list(t.string);

const MenuBarSet = t.struct("MenuBarSet", {
  title: t.opt(t.string),
  icon: t.opt(t.string),
});

/** Page → shell. The names a shell supports reach the page at load. */
export const PAGE_OPS = {
  /** The shell's version and the screen's refresh rate. */
  "app.info": op(
    t.none,
    t.struct("AppInfo", { version: t.string, hz: t.int, test: t.bool }),
  ),
  /**
   * First rows on screen, in ms since navigation start, and WebKit's own
   * first contentful paint if it has one. Logged with --verbose.
   */
  "app.paint": op(
    t.struct("AppPaintArgs", { ms: t.number, fcp: t.opt(t.number) }),
    t.none,
  ),
  /** Move the window with the press the page just saw. True if it moved. */
  "window.drag": op(t.none, t.bool),
  /** Double-click on a title area: what System Settings says. */
  "window.zoom": op(t.none, t.none),
  /** Chords per command id, for the menu bar. */
  "menu.setKeys": op(
    t.struct("MenuSetKeysArgs", { map: t.map(t.list(t.string)) }),
    t.none,
  ),
  /** A menu bar app's icon and title. Unset fields stay as they are. */
  "menuBar.set": op(MenuBarSet, t.none),
  /** Hide a menu bar app's panel. */
  "menuBar.close": op(t.none, t.none),
  /** Where a native browser page shows, in CSS px. Null hides it. */
  "pane.place": op(
    t.struct("PanePlaceArgs", { id: t.string, rect: t.opt(Rect) }),
    t.none,
  ),
} satisfies Record<string, Op>;

/** Shell → page. */
export const SHELL_EVENTS = {
  /** A menu bar app's panel opened (true) or closed (false). */
  "menuBar.open": t.struct("MenuBarOpen", { open: t.bool }),
  /** The window's screen, or its mode, changed. */
  "screen.hz": t.struct("ScreenHz", { hz: t.int }),
  /** A menu item ran a page command. */
  "menu.command": t.struct("MenuCommand", { id: t.string }),
} satisfies Record<string, Ty<unknown>>;

/** Shell → core, unasked: {"ev": name, ...payload}. */
export const CORE_EVENTS = {
  /** The Mac's state, sent when the shell links and on every change. */
  system: t.struct("SystemState", {
    asleep: t.bool,
    online: t.bool,
    lowPower: t.bool,
  }),
} satisfies Record<string, Ty<unknown>>;

/** Core → shell: drive a native browser page. `page` names the page. */
export const CORE_OPS = {
  /** Not a page op: a menu bar app's icon and title (page is ""). */
  menuBar: op(MenuBarSet, t.none),
  open: op(t.struct("PageOpenArgs", { probe: t.opt(t.string) }), t.none),
  close: op(t.none, t.none),
  navigate: op(t.struct("PageNavigateArgs", { url: t.string }), t.none),
  back: op(t.none, t.none),
  forward: op(t.none, t.none),
  reload: op(t.none, t.none),
  /** An expression, awaited, returned as JSON. */
  eval: op(t.struct("PageEvalArgs", { expr: t.string }), ty<unknown>("Any")),
  /** Base64 image. */
  screenshot: op(
    t.struct("PageScreenshotArgs", {
      format: t.opt(t.string),
      quality: t.opt(t.number),
    }),
    t.string,
  ),
  click: op(
    t.struct("PageClickArgs", {
      x: t.number,
      y: t.number,
      count: t.opt(t.int),
      mods: t.opt(Mods),
    }),
    t.none,
  ),
  type: op(t.struct("PageTypeArgs", { text: t.string }), t.none),
  press: op(
    t.struct("PagePressArgs", { key: t.string, mods: t.opt(Mods) }),
    t.none,
  ),
  scroll: op(
    t.struct("PageScrollArgs", { dx: t.number, dy: t.number }),
    t.none,
  ),
  resize: op(t.struct("PageResizeArgs", { w: t.number, h: t.number }), t.none),
} satisfies Record<string, Op>;

const Pane = t.struct("TestPane", {
  hidden: t.bool,
  x: t.number,
  y: t.number,
  w: t.number,
  h: t.number,
});

/**
 * Test → shell. The harness serves a WebSocket; the shell connects to it
 * and runs these. Input goes through AppKit as real events, so it takes the
 * same path as a person's: menus, key equivalents, then the page.
 */
export const TEST_OPS = {
  /** A function body, run in the page and awaited. Its return value, as JSON. */
  eval: op(t.struct("TestEvalArgs", { js: t.string }), ty<unknown>("Any")),
  /** Press a chord like "mod+k", "ctrl+`" or "Escape", as a real key event. */
  key: op(t.struct("TestKeyArgs", { chord: t.string }), t.none),
  /** Type text as real key events (US layout). */
  type: op(t.struct("TestTypeArgs", { text: t.string }), t.none),
  /** Paste text through the Edit menu, as ⌘V does. */
  paste: op(t.struct("TestPasteArgs", { text: t.string }), t.none),
  /** Run a menu command, as a click on its item does. */
  menu: op(t.struct("TestMenuArgs", { id: t.string }), t.none),
  /** A menu item's key equivalent, like "⌘k". Empty if it has none. */
  menuKey: op(t.struct("TestMenuKeyArgs", { id: t.string }), t.string),
  /** Pretend the Mac changed state (asleep, offline, Low Power), as the
   * real notifications would. Fields left out keep their value. */
  system: op(
    t.struct("TestSystemArgs", {
      asleep: t.opt(t.bool),
      online: t.opt(t.bool),
      lowPower: t.opt(t.bool),
    }),
    t.none,
  ),
  /** Put the window in front, so it gets frames and keys. */
  activate: op(t.none, t.none),
  /** A real mouse click at page coordinates (CSS px from the top left). */
  click: op(
    t.struct("TestClickArgs", {
      x: t.number,
      y: t.number,
      count: t.opt(t.int),
      /** "shift", "ctrl", "alt" or "meta". */
      mods: t.opt(t.list(t.string)),
    }),
    t.none,
  ),
  /** The page as it looks now: a PNG, base64. */
  screenshot: op(t.none, t.string),
  /** Window and app state the page can't see. */
  state: op(
    t.none,
    t.struct("TestState", {
      /** window.drag calls since launch. */
      drags: t.int,
      minW: t.number,
      minH: t.number,
      /** The Dock icon's width in px. */
      iconPx: t.int,
      /** The app's own state, from its `appTestState()` hook. */
      app: t.map(t.string),
      /** Who gets keys: "page", "pane:<id>" or another view's class. */
      focus: t.string,
      screens: t.int,
      /** A menu bar app's title, and whether its panel shows. */
      menuBar: t.string,
      panel: t.bool,
      /** The main page's URL; "" until it loads. */
      url: t.string,
      /** Native browser panes by id. */
      panes: t.map(Pane),
    }),
  ),
  /** Prune a context menu shaped like WebKit's: these item ids, "" for a separator. */
  prune: op(
    t.struct("TestPruneArgs", { items: t.list(t.string) }),
    t.list(t.string),
  ),
  /** Move the window to screen `index`. Its name and top rate. */
  screen: op(
    t.struct("TestScreenArgs", { index: t.int }),
    t.struct("TestScreen", { name: t.string, maxFps: t.int }),
  ),
} satisfies Record<string, Op>;

export type PageOp = keyof typeof PAGE_OPS;
export type PageArgs<K extends PageOp> = V<(typeof PAGE_OPS)[K]["args"]>;
export type PageResult<K extends PageOp> = V<(typeof PAGE_OPS)[K]["result"]>;
export type ShellEvent = keyof typeof SHELL_EVENTS;
export type ShellPayload<K extends ShellEvent> = V<(typeof SHELL_EVENTS)[K]>;
export type CoreOp = keyof typeof CORE_OPS;
export type CoreArgs<K extends CoreOp> = V<(typeof CORE_OPS)[K]["args"]>;
export type CoreResult<K extends CoreOp> = V<(typeof CORE_OPS)[K]["result"]>;
export type CoreEvent = keyof typeof CORE_EVENTS;
export type CorePayload<K extends CoreEvent> = V<(typeof CORE_EVENTS)[K]>;
export type TestOp = keyof typeof TEST_OPS;
export type TestArgs<K extends TestOp> = V<(typeof TEST_OPS)[K]["args"]>;
export type TestResult<K extends TestOp> = V<(typeof TEST_OPS)[K]["result"]>;
