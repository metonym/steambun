// Turn a resolved steambun.config.ts into the shell's Swift constants and its
// Info.plist. Errors in the config surface here, at build time.
import type { Item, Key, Resolved } from "../config.ts";

const q = (s: string) => JSON.stringify(s);

/** Carbon virtual key codes (kVK_*) for the hotkey. ANSI layout. */
const KVK: Record<string, number> = {
  a: 0x00, s: 0x01, d: 0x02, f: 0x03, h: 0x04, g: 0x05, z: 0x06, x: 0x07,
  c: 0x08, v: 0x09, b: 0x0b, q: 0x0c, w: 0x0d, e: 0x0e, r: 0x0f, y: 0x10,
  t: 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17,
  "=": 0x18, "9": 0x19, "7": 0x1a, "-": 0x1b, "8": 0x1c, "0": 0x1d, "]": 0x1e,
  o: 0x1f, u: 0x20, "[": 0x21, i: 0x22, p: 0x23, Enter: 0x24, l: 0x25,
  j: 0x26, "'": 0x27, k: 0x28, ";": 0x29, "\\": 0x2a, ",": 0x2b, "/": 0x2c,
  n: 0x2d, m: 0x2e, ".": 0x2f, Tab: 0x30, Space: 0x31, "`": 0x32,
  Backspace: 0x33, Escape: 0x35, F1: 0x7a, F2: 0x78, F3: 0x63, F4: 0x76,
  F5: 0x60, F6: 0x61, F7: 0x62, F8: 0x64, F9: 0x65, F10: 0x6d, F11: 0x67,
  F12: 0x6f,
};

/** Carbon modifier masks: cmdKey, shiftKey, optionKey, controlKey. */
const MODS: Record<string, number> = { mod: 0x100, shift: 0x200, alt: 0x800, ctrl: 0x1000 };

/** "ctrl+alt+Space" → [kVK, Carbon modifiers]. */
export function hotkey(k: Key): [number, number] {
  const parts = k.split("+");
  const key = parts.pop()!;
  let mods = 0;
  for (const m of parts) {
    if (!(m in MODS)) throw new Error(`steambun: hotkey ${k}: unknown modifier ${m}`);
    mods |= MODS[m]!;
  }
  const code = KVK[key] ?? KVK[key.toLowerCase()];
  if (code === undefined) throw new Error(`steambun: hotkey ${k}: unknown key ${key}`);
  if (!mods) throw new Error(`steambun: hotkey ${k}: a global hotkey needs a modifier`);
  return [code, mods];
}

function item(i: Item): string {
  if (i === "-") return ".separator";
  if (typeof i === "string") return `.role(.${i})`;
  return `.command(${q(i.title)}, ${q(i.command)}, ${q(i.key ?? "")})`;
}

const items = (xs: Item[]) => `[${xs.map(item).join(", ")}]`;

/** The file Bun.build writes for a core entry: core/cli.ts → cli.js. */
export const coreScript = (entry: string) => entry.replace(/^.*\//, "").replace(/\.[^.]+$/, "") + ".js";

/** Config.gen.swift: the shell reads these instead of hardcoding ade. */
export function configSwift(c: Resolved, from: string): string {
  const L: string[] = [];
  const w = (s = "") => L.push(s);
  const { Window: win = [], Help: help = [], ...rest } = c.menus;
  const hk = c.hotkey ? hotkey(c.hotkey) : null;
  w(`// Generated from ${from} by steambun/gen. Do not edit.`);
  w();
  w("import AppKit");
  w();
  w("enum Config {");
  w(`  static let name = ${q(c.name)}`);
  w(`  static let id = ${q(c.id)}`);
  w(`  /// "~" is the user's home.`);
  w(`  static let home = ${q(c.home)}`);
  w(`  static let port: UInt16 = ${c.port}`);
  w(`  static let hasCore = ${!!c.core}`);
  w(`  /// The user's own bun runs the core's JS (Resources/core) when true.`);
  w(`  static let systemBun = ${!!c.core && c.bun === "system"}`);
  w(`  static let minBun = ${q(c.minBun)}`);
  w(`  static let coreScript = ${q(c.core ? coreScript(c.core) : "")}`);
  w(`  static let size = NSSize(width: ${c.window.width}, height: ${c.window.height})`);
  w(`  static let minSize = NSSize(width: ${c.window.minWidth}, height: ${c.window.minHeight})`);
  w(`  static let hiddenTitlebar = ${c.window.titlebar === "hidden"}`);
  w(`  static let dragWidth: CGFloat = ${c.window.dragWidth}`);
  const mb = c.menuBar;
  w(`  /// A menu bar app: a status item and a panel, no Dock icon.`);
  w(`  static let menuBar = ${!!mb}`);
  w(`  static let menuBarIcon = ${q(mb ? mb.icon : "")}`);
  w(`  static let menuBarTitle = ${q(mb ? mb.title : "")}`);
  w(`  static let menuBarSize = NSSize(width: ${mb ? mb.width : 0}, height: ${mb ? mb.height : 0})`);
  w(`  static let appMenu: [MenuItemSpec] = ${items(c.appMenu)}`);
  w(`  static let menus: [(String, [MenuItemSpec])] = [`);
  for (const [t, xs] of Object.entries(rest)) w(`    (${q(t)}, ${items(xs)}),`);
  w("  ]");
  w(`  static let windowMenu: [MenuItemSpec] = ${items(win)}`);
  w(`  static let helpMenu: [MenuItemSpec] = ${items(help)}`);
  w(`  /// (kVK, Carbon modifiers) for ${c.hotkey ?? "no hotkey"}.`);
  w(`  static let hotkey: (UInt32, UInt32)? = ${hk ? `(${hk[0]}, ${hk[1]})` : "nil"}`);
  w("}");
  return L.join("\n") + "\n";
}

type Plist = string | number | boolean | { [k: string]: Plist };

function plistValue(v: Plist, ind: string): string {
  if (typeof v === "boolean") return v ? "<true/>" : "<false/>";
  if (typeof v === "number") return `<integer>${v}</integer>`;
  if (typeof v === "string") return `<string>${esc(v)}</string>`;
  const inner = Object.entries(v)
    .map(([k, x]) => `${ind}  <key>${esc(k)}</key>${plistValue(x, ind + "  ")}`)
    .join("\n");
  return `<dict>\n${inner}\n${ind}</dict>`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Info.plist for the bundle. */
export function infoPlist(
  c: Resolved,
  v: { version: string; build: string; updateURL?: string; updateKey?: string },
): string {
  const d: Record<string, Plist> = {
    CFBundleIdentifier: c.id,
    CFBundleName: c.name,
    CFBundleDisplayName: c.name,
    CFBundleExecutable: c.name,
    CFBundlePackageType: "APPL",
    ...(c.icon ? { CFBundleIconFile: "AppIcon" } : {}),
    LSApplicationCategoryType: c.category,
    ...(c.copyright ? { NSHumanReadableCopyright: c.copyright } : {}),
    CFBundleShortVersionString: v.version,
    CFBundleVersion: v.build,
    LSMinimumSystemVersion: "14.0",
    NSHighResolutionCapable: true,
    NSSupportsAutomaticTermination: false,
    NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
    // A menu bar app has no Dock icon and no menu bar of its own.
    ...(c.menuBar ? { LSUIElement: true } : {}),
    // Updates need both; -STEAMBUN_UPDATE_URL at launch can stand in for the URL.
    ...(v.updateKey ? { SteambunUpdateKey: v.updateKey } : {}),
    ...(v.updateURL ? { SteambunUpdateURL: v.updateURL } : {}),
    ...c.plist,
  };
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistValue(d, ""),
    "</plist>",
    "",
  ].join("\n");
}
