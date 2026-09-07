import { describe, expect, test } from "bun:test";
import {
  createRestartTrigger,
  setupDevWatchers,
  shouldTriggerRestart,
} from "../src/dev/watch";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("shouldTriggerRestart", () => {
  const targets = {
    root: "/project",
    envDir: "/project",
    configFileName: "steambun.config.ts",
  };

  test("matches the config file and bunfig.toml in root", () => {
    expect(
      shouldTriggerRestart("change", "/project", "steambun.config.ts", targets),
    ).toBe(true);
    expect(
      shouldTriggerRestart("change", "/project", "bunfig.toml", targets),
    ).toBe(true);
    expect(
      shouldTriggerRestart("change", "/project", "other.ts", targets),
    ).toBe(false);
  });

  test("matches .env* files only in envDir", () => {
    expect(shouldTriggerRestart("change", "/project", ".env", targets)).toBe(
      true,
    );
    expect(
      shouldTriggerRestart("change", "/project", ".env.production", targets),
    ).toBe(true);
    expect(shouldTriggerRestart("change", "/other", ".env", targets)).toBe(
      false,
    );
  });

  test("matches a top-level .html file only on rename, not change", () => {
    expect(
      shouldTriggerRestart("rename", "/project", "about.html", targets),
    ).toBe(true);
    expect(
      shouldTriggerRestart("change", "/project", "about.html", targets),
    ).toBe(false);
  });

  test("a null filename never triggers", () => {
    expect(shouldTriggerRestart("rename", "/project", null, targets)).toBe(
      false,
    );
  });

  test("no configFileName still matches bunfig.toml and .env", () => {
    const noConfig = { ...targets, configFileName: null };
    expect(
      shouldTriggerRestart("change", "/project", "bunfig.toml", noConfig),
    ).toBe(true);
  });
});

describe("createRestartTrigger", () => {
  test("coalesces a burst of notify() calls into one onRestart", async () => {
    let calls = 0;
    const trigger = createRestartTrigger(() => {
      calls++;
    }, 20);

    trigger.notify();
    trigger.notify();
    trigger.notify();
    expect(calls).toBe(0);

    await sleep(40);
    expect(calls).toBe(1);
  });

  test("cancel() suppresses a pending restart", async () => {
    let calls = 0;
    const trigger = createRestartTrigger(() => {
      calls++;
    }, 10);
    trigger.notify();
    trigger.cancel();
    await sleep(30);
    expect(calls).toBe(0);
  });

  test("notify(filename) fires onRestart with that filename", async () => {
    let received: string | null | undefined;
    const trigger = createRestartTrigger((filename) => {
      received = filename;
    }, 10);
    trigger.notify("about.html");
    await sleep(30);
    expect(received).toBe("about.html");
  });

  test("a burst of notifies fires onRestart once with the last filename", async () => {
    const received: Array<string | null> = [];
    const trigger = createRestartTrigger((filename) => {
      received.push(filename);
    }, 20);
    trigger.notify("a");
    trigger.notify("b");
    trigger.notify("c");
    await sleep(40);
    expect(received).toEqual(["c"]);
  });
});

describe("setupDevWatchers", () => {
  test("restarts once for a matching event via an injected watcher", async () => {
    const listeners: Array<{
      dir: string;
      cb: (eventType: string, filename: string | null) => void;
    }> = [];
    let closed = 0;
    let restarts = 0;

    const controller = setupDevWatchers({
      root: "/project",
      envDir: "/project",
      configFileName: "steambun.config.ts",
      debounceMs: 10,
      onRestart: () => {
        restarts++;
      },
      watchDir: (dir, cb) => {
        listeners.push({ dir, cb });
        return { close: () => closed++ };
      },
    });

    // root and envDir are the same directory here, so only one watcher.
    expect(listeners).toHaveLength(1);

    listeners[0]!.cb("change", "steambun.config.ts");
    listeners[0]!.cb("change", "unrelated.ts");
    await sleep(30);
    expect(restarts).toBe(1);

    controller.close();
    expect(closed).toBe(1);
  });

  test("passes the triggering filename to onRestart", async () => {
    const listeners: Array<{
      dir: string;
      cb: (eventType: string, filename: string | null) => void;
    }> = [];
    let receivedFilename: string | null | undefined;

    const controller = setupDevWatchers({
      root: "/project",
      envDir: "/project",
      configFileName: "steambun.config.ts",
      debounceMs: 10,
      onRestart: (filename) => {
        receivedFilename = filename;
      },
      watchDir: (dir, cb) => {
        listeners.push({ dir, cb });
        return { close: () => {} };
      },
    });

    listeners[0]!.cb("change", "steambun.config.ts");
    await sleep(30);
    expect(receivedFilename).toBe("steambun.config.ts");

    controller.close();
  });

  test("watches root and envDir separately when they differ", () => {
    const dirs: string[] = [];
    const controller = setupDevWatchers({
      root: "/project",
      envDir: "/project/config",
      configFileName: null,
      onRestart: () => {},
      watchDir: (dir) => {
        dirs.push(dir);
        return { close: () => {} };
      },
    });
    expect(dirs.sort()).toEqual(["/project", "/project/config"]);
    controller.close();
  });
});
