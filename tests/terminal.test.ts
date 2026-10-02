import { describe, expect, spyOn, test } from "bun:test";
import { fail, log, ok, pad, setLogLevel, warn } from "../src/util/terminal";

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

// Every case runs on a TTY with TERM != "dumb": ok/warn/fail only call paint() then.
describe("ok/warn/fail color handling (via paint, on a real TTY)", () => {
  test("NO_COLOR set to anything disables color, even an empty string", () => {
    withEnv(
      { NO_COLOR: "1", FORCE_COLOR: undefined, TERM: "xterm-256color" },
      () => {
        withTTY(true, () => {
          expect(ok("done")).toBe("✓ done");
        });
      },
    );
    withEnv(
      { NO_COLOR: "", FORCE_COLOR: undefined, TERM: "xterm-256color" },
      () => {
        withTTY(true, () => {
          expect(ok("done")).toBe("✓ done");
        });
      },
    );
  });

  test("FORCE_COLOR=0 does not force color on", () => {
    withEnv(
      { NO_COLOR: undefined, FORCE_COLOR: "0", TERM: "xterm-256color" },
      () => {
        withTTY(false, () => {
          expect(ok("done")).toBe("OK done");
        });
      },
    );
    // Bun.color's own FORCE_COLOR detection is fixed at process start, so mock it.
    const colorSpy = spyOn(Bun, "color").mockImplementation(
      (() => "\x1b[32m") as unknown as typeof Bun.color,
    );
    try {
      withEnv(
        { NO_COLOR: undefined, FORCE_COLOR: "0", TERM: "xterm-256color" },
        () => {
          withTTY(true, () => {
            expect(ok("done")).toBe("\x1b[32m✓\x1b[0m done");
          });
        },
      );
    } finally {
      colorSpy.mockRestore();
    }
  });

  test("wraps the glyph in ANSI codes when color is enabled", () => {
    // Bun.color's own detection is fixed at process start, so mock it.
    const colorSpy = spyOn(Bun, "color").mockImplementation(
      (() => "\x1b[32m") as unknown as typeof Bun.color,
    );
    try {
      withEnv(
        { NO_COLOR: undefined, FORCE_COLOR: "1", TERM: "xterm-256color" },
        () => {
          withTTY(true, () => {
            expect(ok("done")).toBe("\x1b[32m✓\x1b[0m done");
          });
        },
      );
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
      withEnv(
        { NO_COLOR: undefined, FORCE_COLOR: "1", TERM: "xterm-256color" },
        () => {
          withTTY(true, () => {
            const painted = ok("hi");
            expect(painted).toBe("\x1b[32m✓\x1b[0m hi");
            // pad must measure with Bun.stringWidth, which ignores ANSI escapes.
            expect(painted.length).toBeGreaterThan(Bun.stringWidth(painted));
            expect(pad(painted, Bun.stringWidth(painted) + 3)).toBe(
              `${painted}   `,
            );
          });
        },
      );
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
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      log.info("a");
      log.error("c");
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test("warn level allows error but not info", () => {
    setLogLevel("warn");
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      log.info("a");
      log.error("c");
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith("c");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
