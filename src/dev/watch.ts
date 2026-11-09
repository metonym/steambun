import { type FSWatcher, watch } from "node:fs";
import { basename } from "node:path";
import { isSkippedPath } from "./discover";

export interface WatchTargets {
  root: string;
  envDir: string;
  configFileName: string | null;
  /** `discoverSkipDirs(config)`: directories whose HTML never counts as an entry. */
  skip?: { skipDirs?: string[]; skipPaths?: string[] };
}

/** HTML restarts only on `rename` (add/remove) outside skipped dirs; a `change` is a content edit that `--hot` handles. */
export function shouldTriggerRestart(
  eventType: string,
  dir: string,
  filename: string | null,
  targets: WatchTargets,
): boolean {
  if (!filename) return false;
  if (
    dir === targets.root &&
    (filename === targets.configFileName ||
      filename === "bunfig.toml" ||
      (eventType === "rename" &&
        filename.endsWith(".html") &&
        !isSkippedPath(filename, targets.skip)))
  ) {
    return true;
  }
  return (
    dir === targets.envDir &&
    (filename === ".env" || filename.startsWith(".env."))
  );
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    notify(filename = null) {
      clearTimeout(timer);
      timer = setTimeout(() => onRestart(filename), debounceMs);
    },
    cancel() {
      clearTimeout(timer);
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
  /** Injectable for tests. */
  watchDir?: WatchFn;
}

// Linux's inotify-backed recursive watch can miss directories created after
// startup (oven-sh/bun#15939).
export function setupDevWatchers(opts: DevWatchOptions): { close(): void } {
  // Nothing under a skipped dir can trigger a restart, so keep the OS watcher out of it (node_modules especially).
  const ignore = (rel: string) =>
    isSkippedPath(rel, opts.skip) || basename(rel) === "node_modules";
  const watchDir: WatchFn =
    opts.watchDir ??
    ((dir, listener) => watch(dir, { recursive: true, ignore }, listener));
  const trigger = createRestartTrigger(opts.onRestart, opts.debounceMs);

  const watchers = [...new Set([opts.root, opts.envDir])].map((dir) =>
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
