// Durable UI settings: theme, key map, pane sizes, toggles.
//
// The core stores them (steambun/core settings), so they survive a port
// change and the browser tab and the app share them. Each origin has its
// own localStorage, so one app on two ports would keep two sets.
//
//   await loadSettings();                 // once, before modules read them
//   getSetting("theme"); setSetting("theme", "dark"); removeSetting("theme");
//
// Reads are synchronous from a snapshot that `loadSettings()` fetches once.
// Await it in the entry before importing the app, so module-level reads see
// it. Not a top-level await here: Bun's dev HMR runtime gives a second
// importer of a pending async module null exports. Writes update the
// snapshot, mirror to localStorage, and reach the core in one batched PUT.
// With no core (a static page, a perf run), the fetch fails and
// localStorage is the store.

export type SettingsOptions = {
  /** Which keys the core keeps. Others stay in this origin. Default: all. */
  durable?: (key: string) => boolean;
};

let isDurable: (k: string) => boolean = () => true;

let snap: Record<string, string> | null = null;
const pending: Record<string, string | null> = {};
let timer: ReturnType<typeof setTimeout> | undefined;

function local(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (isDurable(k)) out[k] = localStorage.getItem(k)!;
  }
  return out;
}

function flush(keepalive = false) {
  clearTimeout(timer);
  timer = undefined;
  const body = JSON.stringify(pending);
  for (const k in pending) delete pending[k];
  if (body === "{}" || !snap) return;
  fetch("/_steambun/settings", { method: "PUT", body, keepalive }).catch(() => {});
}

function queue(k: string, v: string | null) {
  if (!snap) return;
  pending[k] = v;
  timer ??= setTimeout(flush, 150);
}

/** Fetch the snapshot. Await it before any module reads a setting. */
export async function loadSettings(opts: SettingsOptions = {}) {
  if (opts.durable) isDurable = opts.durable;
  try {
    const r = await fetch("/_steambun/settings");
    if (!r.ok) return;
    snap = (await r.json()) as Record<string, string>;
  } catch {
    return;
  }
  // First run with a core: bring over what this origin had.
  if (!Object.keys(snap).length) {
    const old = local();
    Object.assign(snap, old);
    for (const k in old) queue(k, old[k]);
  }
  addEventListener("pagehide", () => flush(true));
  // Another tab on this origin wrote a key.
  addEventListener("storage", (e: StorageEvent) => {
    if (!snap || !e.key || !isDurable(e.key)) return;
    if (e.newValue === null) delete snap[e.key];
    else snap[e.key] = e.newValue;
  });
}

export function getSetting(k: string): string | null {
  if (snap && isDurable(k)) return snap[k] ?? null;
  return localStorage.getItem(k);
}

export function setSetting(k: string, v: string) {
  localStorage.setItem(k, v);
  if (!snap || !isDurable(k) || snap[k] === v) return;
  snap[k] = v;
  queue(k, v);
}

export function removeSetting(k: string) {
  localStorage.removeItem(k);
  if (!snap || !isDurable(k) || !(k in snap)) return;
  delete snap[k];
  queue(k, null);
}

/** True when the core holds the settings. */
export const settingsInCore = () => snap !== null;
