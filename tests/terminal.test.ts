import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  colorEnabled,
  fail,
  getLogLevel,
  log,
  ok,
  pad,
  paint,
  setLogLevel,
  warn,
} from "../src/util/terminal";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withTTY(isTTY: boolean | undefined, fn: () => void) {
  const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", {
    value: isTTY,
    configurable: true,
  });
  try {
    fn();
  } finally {
    if (original) Object.defineProperty(process.stdout, "isTTY", original);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
}

describe("colorEnabled", () => {
  test("NO_COLOR set to anything disables color, even an empty string", () => {
    withEnv({ NO_COLOR: "1", FORCE_COLOR: undefined }, () => {
      withTTY(true, () => {
        expect(colorEnabled()).toBe(false);
      });
    });
    withEnv({ NO_COLOR: "", FORCE_COLOR: undefined }, () => {
      withTTY(true, () => {
        expect(colorEnabled()).toBe(false);
      });
    });
  });

  test("FORCE_COLOR=1 forces color on a non-TTY", () => {
    withEnv({ NO_COLOR: undefined, FORCE_COLOR: "1" }, () => {
      withTTY(false, () => {
        expect(colorEnabled()).toBe(true);
      });
    });
  });

  test("FORCE_COLOR=0 does not force color on", () => {
    withEnv({ NO_COLOR: undefined, FORCE_COLOR: "0" }, () => {
      withTTY(false, () => {
        expect(colorEnabled()).toBe(false);
      });
      withTTY(true, () => {
        expect(colorEnabled()).toBe(true);
      });
    });
  });

  test("falls back to the TTY check", () => {
    withEnv({ NO_COLOR: undefined, FORCE_COLOR: undefined }, () => {
      withTTY(true, () => {
        expect(colorEnabled()).toBe(true);
      });
      withTTY(false, () => {
        expect(colorEnabled()).toBe(false);
      });
    });
  });
});

describe("paint", () => {
  test("returns plain text when color is disabled", () => {
    withEnv({ NO_COLOR: "1" }, () => {
      expect(paint("hello", "green")).toBe("hello");
    });
  });

  test("wraps in ANSI codes when color is enabled", () => {
    // Bun.color's own TTY/FORCE_COLOR detection is fixed at process start, so
    // mutating process.env mid-test can't move it — mock it instead to
    // exercise paint()'s own colorEnabled() gate deterministically.
    const colorSpy = spyOn(Bun, "color").mockImplementation(
      (() => "\x1b[32m") as unknown as typeof Bun.color,
    );
    try {
      withEnv({ NO_COLOR: undefined, FORCE_COLOR: "1" }, () => {
        const painted = paint("hello", "green");
        expect(painted).toBe("\x1b[32mhello\x1b[0m");
      });
    } finally {
      colorSpy.mockRestore();
    }
  });
});

describe("pad", () => {
  test("pads at the end by default", () => {
    expect(pad("hi", 5)).toBe("hi   ");
  });

  test("pads at the start when requested", () => {
    expect(pad("hi", 5, "start")).toBe("   hi");
  });

  test("leaves text unchanged when already at or over width", () => {
    expect(pad("hello", 3)).toBe("hello");
  });

  test("measures visual width, ignoring ANSI codes", () => {
    const colorSpy = spyOn(Bun, "color").mockImplementation(
      (() => "\x1b[32m") as unknown as typeof Bun.color,
    );
    try {
      withEnv({ NO_COLOR: undefined, FORCE_COLOR: "1" }, () => {
        const painted = paint("hi", "green");
        expect(painted).toBe("\x1b[32mhi\x1b[0m");
        expect(pad(painted, 5)).toBe(`${painted}   `);
      });
    } finally {
      colorSpy.mockRestore();
    }
  });
});

describe("ok/warn/fail", () => {
  test("use ASCII glyphs when TERM=dumb", () => {
    withEnv({ TERM: "dumb" }, () => {
      withTTY(true, () => {
        expect(ok("done")).toBe("OK done");
        expect(warn("careful")).toBe("!! careful");
        expect(fail("broken")).toBe("XX broken");
      });
    });
  });

  test("use ASCII glyphs when not a TTY", () => {
    withEnv({ TERM: undefined }, () => {
      withTTY(false, () => {
        expect(ok("done")).toBe("OK done");
        expect(warn("careful")).toBe("!! careful");
        expect(fail("broken")).toBe("XX broken");
      });
    });
  });

  test("use unicode glyphs on a real TTY", () => {
    withEnv({ TERM: "xterm-256color" }, () => {
      withTTY(true, () => {
        expect(ok("done")).toContain("done");
        expect(ok("done")).not.toContain("OK");
      });
    });
  });
});

describe("log", () => {
  const originalLevel = getLogLevel();

  beforeEach(() => {
    setLogLevel("info");
  });

  afterEach(() => {
    setLogLevel(originalLevel);
  });

  test("info fires at the default level", () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      log.info("hello");
      expect(spy).toHaveBeenCalledWith("hello");
    } finally {
      spy.mockRestore();
    }
  });

  test("silent suppresses everything", () => {
    setLogLevel("silent");
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      log.info("a");
      log.warn("b");
      log.error("c");
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test("warn level allows warn and error but not info", () => {
    setLogLevel("warn");
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      log.info("a");
      log.warn("b");
      log.error("c");
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith("b");
      expect(errorSpy).toHaveBeenCalledWith("c");
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
