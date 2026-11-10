// The app's manifest. Every field has a default, so a small app needs no
// config at all: the name comes from package.json, a `core.ts` at the
// root turns on the Bun core, and the page is `index.html`.
//
// To set anything, add steambun.config.ts at the app's root:
//
//   import { defineApp } from "steambun/config";
//   export default defineApp({ id: "com.example.notes", menus: { … } });
//
// or a "steambun" object in package.json. The build turns it into the
// shell's constants (Config.gen.swift) and Info.plist, so an app changes
// its window, menus and keys here, not in Swift.
//
// UI build plugins (Svelte, Vue, …) go in bunfig.toml's [serve.static]
// plugins: the dev server reads them there, and `steambun build` too.
// React needs none: Bun has JSX and Fast Refresh built in.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A key chord in the page's syntax: "mod+k", "mod+shift+[", "ctrl+`". */
export type Key = string;

/** Standard menu items. AppKit does the work; no page code needed. */
export type Role =
  | "about"
  | "updates"
  | "hide"
  | "hideOthers"
  | "showAll"
  | "quit"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "selectAll"
  | "reload"
  | "fullscreen"
  | "minimize"
  | "zoom"
  | "close";

/**
 * A menu item: "-" for a separator, a role, or a page command. A command
 * item sends `menu.command { id }` to the page. Its key is the default
 * until the page sends its own key map (`menu.setKeys`).
 */
export type Item = "-" | Role | { title: string; command: string; key?: Key };

/**
 * A toolbar item: "-" for a flexible space, or a button that sends
 * `menu.command { id }` to the page, as a menu item does. `symbol` is an
 * SF Symbol name; `title` is its label and tooltip.
 */
export type ToolbarItem =
  "-" | { title: string; command: string; symbol: string };

export interface AppConfig {
  /**
   * Shown in the menu bar and Finder; also the bundle and binary name.
   * Default: package.json's name in PascalCase: `todo-bar` is TodoBar.
   */
  name?: string;
  /**
   * Bundle id, reverse DNS: "com.example.notes". It names the app's data
   * (settings, storage), so it can't change after you ship. Default:
   * "local.steambun.<name>", fine for dev; a signed build needs a real one.
   */
  id?: string;
  /** Where the core keeps data. The shell passes it as STEAMBUN_HOME. */
  home?: string;
  /** The core's preferred port. Default: one derived from `id`. */
  port?: number;
  window?: {
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
    /**
     * "hidden": content runs under a transparent title bar, and the page
     * pads for it with `--shell-titlebar`. "default": a normal title bar.
     */
    titlebar?: "hidden" | "default";
    /** Width of the native drag strip at the top left (hidden title bar). */
    dragWidth?: number;
  };
  /**
   * A menu bar app: an icon in the menu bar, no Dock icon, no window at
   * launch. A click on the icon shows the page in a panel under it. With a
   * core, the page loads on the first click, so an idle app runs no web
   * view; the core can set the icon's title (`setMenuBar`). With no core,
   * the page loads at launch, since it is the app.
   */
  menuBar?:
    | boolean
    | {
        /** An SF Symbol name. Default "circle.fill". */
        icon?: string;
        /** Text next to the icon. The page or core can change it. */
        title?: string;
        /** The panel's size. Default 360 × 480. */
        width?: number;
        height?: number;
      };
  /**
   * Menus between Edit and Window, in order. "Window" and "Help" keys add
   * to the standard Window menu and a Help menu at the end.
   * The app menu (About, Updates, Hide, Quit) and Edit are always there.
   */
  menus?: Record<string, Item[]>;
  /** Items for the app menu, after "Check for Updates…". */
  appMenu?: Item[];
  /**
   * A native toolbar at the top of the window, in order. It gets the
   * system's look: Liquid Glass on macOS 26. The window gets a normal
   * title bar, and the page starts below the toolbar. A menu bar app has
   * no toolbar. In a tab, the page draws its own (same items: import
   * them from package.json).
   */
  toolbar?: ToolbarItem[];
  /** A global chord that shows or hides the app: "ctrl+alt+Space". */
  hotkey?: Key;
  /**
   * Real glass behind the page: Liquid Glass on macOS 26 and later, the
   * older blur before that. The page shows it wherever its background is
   * transparent, which is the default. In a browser tab, nothing changes.
   */
  glass?: boolean;
  /** The update feed and its ed25519 public key. Updates need both. */
  update?: { url?: string; key?: string };
  /**
   * The Bun core's entry file, from the app's root. It serves the page and
   * the app's routes. Default: "core.ts" or "core/index.ts", whichever
   * exists, else no core. With no core, the .app holds only the shell and
   * the built page, about 1 MB, with no Bun inside. `false` turns the core
   * off.
   */
  core?: string | false;
  /**
   * Which Bun runs the core. "bundled" (default): the core compiles to one
   * AOT binary inside the .app, about 40 MB. "system": the .app holds the
   * core's JS (about 0.1 MB) and runs it with the user's own `bun`, at
   * least the version that built it. Users without Bun see how to get it.
   */
  bun?: "bundled" | "system";
  /** The page's HTML entry, when there is no core. Default "index.html". */
  page?: string;
  /** The app's bridge schema (`defineBridge`). Default "native/bridge.ts", if it exists. */
  bridge?: string;
  /** The app's Swift files. Default "native/Sources". */
  swift?: string;
  /** Where every build output goes: the .app, the page, the core. Default "build". */
  out?: string;
  /** Path to an .icns, from the app's root. */
  icon?: string;
  /** Extra Info.plist keys, such as NS…UsageDescription. */
  plist?: Record<string, string | boolean | number>;
  copyright?: string;
  /** LSApplicationCategoryType. */
  category?: string;
}

/** Type-check the config. Returns it unchanged. */
export function defineApp(c: AppConfig): AppConfig {
  return c;
}

/** The config with every default filled in. */
export type Resolved = Required<
  Omit<
    AppConfig,
    "window" | "update" | "icon" | "hotkey" | "bridge" | "core" | "menuBar"
  >
> & {
  /** The menu bar icon, or false for a normal windowed app. */
  menuBar: false | Required<Exclude<AppConfig["menuBar"], boolean | undefined>>;
  /** The core's entry, or false for a page-only app. */
  core: string | false;
  /** The oldest `bun` that may run a "system" core: the one that built it. */
  minBun: string;
  /** True if `id` is the default, not one the app chose. */
  idDefault: boolean;
  window: Required<NonNullable<AppConfig["window"]>>;
  update: NonNullable<AppConfig["update"]>;
  icon?: string;
  hotkey?: Key;
  bridge?: string;
  /** The app's root folder: absolute. Paths above are relative to it. */
  root: string;
};

/** A port in 20000–29999 from the id, so two steambun apps don't collide. */
function portFor(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 20000 + (h % 10000);
}

/** Where steambun looks for a core, in order. */
const CORE_ENTRIES = ["core.ts", "core/index.ts"];

/** `todo-bar` → `TodoBar`, `notes` → `Notes`. */
const pascal = (s: string) =>
  s.replace(/(^|[-_.\s]+)(\w)/g, (_, _sep, ch: string) => ch.toUpperCase());

export function resolve(
  c: AppConfig,
  root = process.cwd(),
  pkgName?: string,
): Resolved {
  const from = pkgName?.replace(/^@[^/]+\//, "");
  const name = c.name ?? (from ? pascal(from) : undefined);
  if (!name)
    throw new Error(
      "steambun: no name: add one to package.json or steambun.config.ts",
    );
  if (!/^[A-Za-z][\w-]*$/.test(name))
    throw new Error(`steambun: bad name ${name}`);
  const id = c.id ?? `local.steambun.${name.toLowerCase()}`;
  if (!/^[A-Za-z][\w-]*(\.[A-Za-z][\w-]*)+$/.test(id))
    throw new Error(`steambun: bad id ${id}`);
  const core =
    c.core ?? CORE_ENTRIES.find((f) => existsSync(join(root, f))) ?? false;
  checkKeys([...(c.appMenu ?? []), ...Object.values(c.menus ?? {}).flat()]);
  return {
    name,
    id,
    idDefault: !c.id,
    home: c.home ?? `~/Library/Application Support/${name}`,
    port: c.port ?? portFor(id),
    window: {
      width: 1280,
      height: 800,
      minWidth: 640,
      minHeight: 400,
      titlebar: "hidden",
      dragWidth: 240,
      ...c.window,
    },
    menuBar: c.menuBar
      ? {
          icon: "circle.fill",
          title: "",
          width: 360,
          height: 480,
          ...(c.menuBar === true ? {} : c.menuBar),
        }
      : false,
    menus: c.menus ?? {},
    toolbar: c.menuBar ? [] : (c.toolbar ?? []),
    appMenu: c.appMenu ?? [],
    hotkey: c.hotkey,
    glass: c.glass ?? false,
    update: c.update ?? {},
    core: core || false,
    bun: c.bun ?? "bundled",
    minBun: Bun.version.replace(/-.*/, ""),
    page: c.page ?? "index.html",
    bridge:
      c.bridge ??
      (existsSync(join(root, "native/bridge.ts"))
        ? "native/bridge.ts"
        : undefined),
    swift: c.swift ?? "native/Sources",
    out: c.out ?? "build",
    root,
    icon: c.icon,
    plist: c.plist ?? {},
    copyright: c.copyright ?? "",
    category: c.category ?? "public.app-category.productivity",
  };
}

/**
 * Chords the shell's own menus use. AppKit drops a second item with the
 * same key, so the app's item would show no key and never fire.
 */
const SHELL_KEYS: Record<string, string> = {
  "mod+h": "Hide",
  "mod+alt+h": "Hide Others",
  "mod+q": "Quit",
  "mod+z": "Undo",
  "mod+shift+z": "Redo",
  "mod+x": "Cut",
  "mod+c": "Copy",
  "mod+v": "Paste",
  "mod+a": "Select All",
  "mod+alt+r": "Reload Page",
  "mod+ctrl+f": "Enter Full Screen",
  "mod+m": "Minimize",
  "mod+w": "Close",
};

/** Sort the modifiers, so "shift+mod+Z" and "mod+shift+z" match. */
const normKey = (k: string) => {
  const parts = k.endsWith("++")
    ? [...k.slice(0, -2).split("+"), "+"]
    : k.split("+");
  const key = parts.pop()!;
  return [...parts.sort(), key.length === 1 ? key.toLowerCase() : key].join(
    "+",
  );
};

function checkKeys(items: Item[]) {
  const owned = new Map(
    Object.entries(SHELL_KEYS).map(([k, v]) => [normKey(k), v]),
  );
  const seen = new Map<string, string>();
  for (const it of items) {
    if (typeof it !== "object" || !it.key) continue;
    const k = normKey(it.key);
    const shell = owned.get(k);
    if (shell)
      throw new Error(
        `steambun: "${it.title}" uses ${it.key}, which macOS gives to ${shell}. Pick another key.`,
      );
    const other = seen.get(k);
    if (other)
      throw new Error(
        `steambun: "${it.title}" and "${other}" both use ${it.key}.`,
      );
    seen.set(k, it.title);
  }
}

/**
 * Load and resolve the app at `root`: steambun.config.ts if it exists,
 * else package.json's "steambun" object, else all defaults.
 */
export async function loadConfig(root: string): Promise<Resolved> {
  return loadConfigSync(root);
}

/** loadConfig, at once: for code that must not await, like describe(). */
export function loadConfigSync(root: string): Resolved {
  const pkgFile = join(root, "package.json");
  const pkg = existsSync(pkgFile)
    ? (JSON.parse(readFileSync(pkgFile, "utf8")) as {
        name?: string;
        steambun?: AppConfig;
      })
    : {};
  const file = join(root, "steambun.config.ts");
  const c = existsSync(file)
    ? (require(file) as { default: AppConfig }).default
    : (pkg.steambun ?? {});
  return resolve(c, root, pkg.name);
}
