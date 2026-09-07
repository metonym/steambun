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
  let lastFilename: string | null = null;
  return {
    notify(filename = null) {
      lastFilename = filename;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const firedFilename = lastFilename;
        lastFilename = null;
        onRestart(firedFilename);
      }, debounceMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      lastFilename = null;
    },
  };
}

type WatchFn = (
  dir: string,
  listener: (eventType: string, filename: string | null) => void,
) => Pick<FSWatcher, "close">;

export interface DevWatchOptions {
  root: string;
  envDir: string;
  configFileName: string | null;
  onRestart: (filename: string | null) => void;
  debounceMs?: number;
  /** Injectable for tests — defaults to `node:fs`'s `watch`, recursive on `root`. */
  watchDir?: WatchFn;
}

export interface DevWatchController {
  close(): void;
}

const defaultWatchDir: WatchFn = (dir, listener) => watch(dir, listener);

/**
 * Watches `root` (config file, `bunfig.toml`, top-level `*.html` add/remove)
 * and `envDir` (`.env*` files) non-recursively, restarting the dev server on
 * a match. Nested HTML directories are out of scope — only the immediate
 * children of `root` are watched.
 */
export function setupDevWatchers(opts: DevWatchOptions): DevWatchController {
  const watchDir = opts.watchDir ?? defaultWatchDir;
  const trigger = createRestartTrigger(opts.onRestart, opts.debounceMs);
  const targets: WatchTargets = {
    root: opts.root,
    envDir: opts.envDir,
    configFileName: opts.configFileName,
  };

  const dirs = new Set([opts.root, opts.envDir]);
  const watchers = [...dirs].map((dir) =>
    watchDir(dir, (eventType, filename) => {
      if (shouldTriggerRestart(eventType, dir, filename, targets)) {
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
