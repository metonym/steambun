import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapLimit } from "../src/build/concurrency";
import { buildFileType, formatSize } from "../src/util/format";
import { asStringArray, isIdentifier, isPlainObject } from "../src/util/guards";
import { isInside, resolveFrom } from "../src/util/paths";
import { HOOK_KEYS, isSteambunHooks } from "../src/util/plugins";
import {
  posixRelative,
  toImportSpecifier,
  toPosix,
} from "../src/util/specifier";
import { writeIfChanged } from "../src/util/write-if-changed";

describe("isInside / resolveFrom", () => {
  test("isInside is strict: the directory itself and siblings are outside", () => {
    expect(isInside("/r", "/r/a")).toBe(true);
    expect(isInside("/r", "/r")).toBe(false);
    expect(isInside("/r", "/x")).toBe(false);
    expect(isInside("/r", "/r/../x")).toBe(false);
    expect(isInside("/r", "/r/..foo")).toBe(true);
  });

  test("resolveFrom passes absolute paths through and joins relative ones", () => {
    expect(resolveFrom("/r", "/a")).toBe("/a");
    expect(resolveFrom("/r", "a/b")).toBe("/r/a/b");
  });
});

describe("specifiers", () => {
  test("toImportSpecifier is always relative, even for dot-prefixed names", () => {
    expect(toImportSpecifier("/app/.steambun", "/app/.steambun/env.d.ts")).toBe(
      "./env.d.ts",
    );
    expect(toImportSpecifier("/app", "/app/.steambun/env.d.ts")).toBe(
      "./.steambun/env.d.ts",
    );
    expect(toImportSpecifier("/app/.steambun", "/app/src/api.ts")).toBe(
      "../src/api.ts",
    );
  });

  test("toPosix rewrites only the native separator, so a POSIX backslash filename survives", () => {
    expect(toPosix("a\\b\\c.ts", "\\")).toBe("a/b/c.ts");
    expect(toPosix("a\\b/c.ts", "/")).toBe("a\\b/c.ts");
    expect(toPosix("a/b.ts", "/")).toBe("a/b.ts");
  });

  test("posixRelative is relative and slash-separated", () => {
    expect(posixRelative("/app", "/app/src/x.ts")).toBe("src/x.ts");
    expect(posixRelative("/app/src", "/app/x.ts")).toBe("../x.ts");
  });
});

describe("format", () => {
  test("formatSize switches units at 1024 bytes and 1 MB", () => {
    expect(formatSize(642)).toBe("642 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(1572864)).toBe("1.5 MB");
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
  });

  test("buildFileType classifies html, css, js/mjs; everything else is undefined", () => {
    expect(buildFileType("index.html")).toBe("html");
    expect(buildFileType("assets/a.css")).toBe("css");
    expect(buildFileType("assets/a.js")).toBe("js");
    expect(buildFileType("assets/a.mjs")).toBe("js");
    expect(buildFileType("assets/a.png")).toBeUndefined();
  });
});

describe("guards", () => {
  test("isPlainObject rejects arrays, null, and class instances", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    for (const value of [[], null, new Date(), /x/, new (class A {})(), "s"]) {
      expect(isPlainObject(value)).toBe(false);
    }
  });

  test("asStringArray refuses a mixed array instead of filtering it", () => {
    expect(asStringArray(["a", "b"])).toEqual(["a", "b"]);
    expect(asStringArray(["a", 1])).toBeUndefined();
    expect(asStringArray("a")).toBeUndefined();
  });

  test("isIdentifier", () => {
    expect(isIdentifier("PUBLIC_A")).toBe(true);
    expect(isIdentifier("$x")).toBe(true);
    expect(isIdentifier("a-b")).toBe(false);
    expect(isIdentifier("1a")).toBe(false);
    expect(isIdentifier("")).toBe(false);
  });
});

test("every hook key makes an object a steambun hooks plugin", () => {
  for (const key of HOOK_KEYS) {
    expect(isSteambunHooks({ [key]: () => {} })).toBe(true);
  }
  expect(isSteambunHooks({ name: "only-a-name" })).toBe(false);
});

describe("mapLimit", () => {
  test("keeps item order and never exceeds the limit", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([30, 1, 20, 1, 10], 2, async (ms, index) => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(ms);
      active--;
      return `${index}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:1", "2:20", "3:1", "4:10"]);
    expect(peak).toBe(2);
  });

  test("an empty list resolves to an empty list", async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });

  test("a rejection rejects the whole call", async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("two");
        return n;
      }),
    ).rejects.toThrow("two");
  });
});

describe("writeIfChanged", () => {
  test("writes new content, and leaves an unchanged file's mtime alone", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "steambun-wic-")), "x.txt");
    expect(await writeIfChanged(path, "a")).toBe(true);
    utimesSync(path, 1, 1);
    expect(await writeIfChanged(path, "a")).toBe(false);
    expect(statSync(path).mtimeMs).toBe(1000);
    expect(await writeIfChanged(path, "b")).toBe(true);
    expect(await Bun.file(path).text()).toBe("b");
  });
});
