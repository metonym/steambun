import { type FSWatcher, watch } from "node:fs";

export interface WatchTargets {
  root: string;
  envDir: string;
  configFileName: string | null;
}

/**
 * Decides whether a raw `fs.watch` event should trigger a dev server
 * restart. `dir` is the directory being watched (root or envDir — they may
 * be the same); `eventType`/`filename` come straight from the watch
 * callback. HTML files only restart on `rename` (add/remove) — a `change`
 * event is a content edit, which `--hot` already handles.
 */
export function shouldTriggerRestart(
  eventType: string,
  dir: string,
  filename: string | null,
  targets: WatchTargets,
): boolean {
  if (!filename) return false;

  if (dir === targets.root) {
    if (targets.configFileName && filename === targets.configFileName) {
      return true;
    }
    if (filename === "bunfig.toml") return true;
    if (eventType === "rename" && filename.endsWith(".html")) return true;
  }

  if (dir === targets.envDir) {
    if (filename === ".env" || filename.startsWith(".env.")) return true;
  }

  return false;
}

export interface RestartTrigger {
  notify(filename?: string | null): void;
  cancel(): void;
}

/** Coalesces bursts of filesystem events (e.g. an editor's save) into one restart. */
export function createRestartTrigger(
  onRestart: (filename: string | null) => void,
  debounceMs = 100,
): RestartTrigger {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    notify(filename = null) {
      if (timer) clearTimeout(timer);
      // The newest notify() always replaces the pending timer, so the
      // filename this closure captures is always the last one notified —
      // no need to track it separately.
      timer = setTimeout(() => {
        timer = null;
        onRestart(filename);
      }, debounceMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

type WatchFn = (
  dir: string,
  listener: (eventType: string, filename: string | null) => void,
) => Pick<FSWatcher, "close">;

export interface DevWatchOptions extends WatchTargets {
  onRestart: (filename: string | null) => void;
  debounceMs?: number;
  /** Injectable for tests — defaults to `node:fs`'s `watch`, recursive on `root`. */
  watchDir?: WatchFn;
}

export interface DevWatchController {
  close(): void;
}

const defaultWatchDir: WatchFn = (dir, listener) =>
  watch(dir, { recursive: true }, listener);

/**
 * Watches `root` recursively (config file, `bunfig.toml`, `*.html` add/remove
 * at any depth) and `envDir` (`.env*` files, top-level only), restarting the
 * dev server on a match. `fs.watch`'s recursive option is native on
 * macOS/Windows; on Linux (inotify-backed) a directory created after the
 * watcher started may not be included until the process restarts (see
 * oven-sh/bun#15939) — this is a platform gap, not silently degraded.
 */
export function setupDevWatchers(opts: DevWatchOptions): DevWatchController {
  const watchDir = opts.watchDir ?? defaultWatchDir;
  const trigger = createRestartTrigger(opts.onRestart, opts.debounceMs);

  const dirs = new Set([opts.root, opts.envDir]);
  const watchers = [...dirs].map((dir) =>
    watchDir(dir, (eventType, filename) => {
      if (shouldTriggerRestart(eventType, dir, filename, opts)) {
        trigger.notify(filename);
      }
    }),
  );

  return {
    close() {
      trigger.cancel();
      for (const w of watchers) w.close();
    },
  };
}
