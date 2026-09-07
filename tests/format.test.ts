import { describe, expect, test } from "bun:test";
import { buildFileType, formatSize } from "../src/util/format";

describe("formatSize", () => {
  test("bytes under 1024 print as N B", () => {
    expect(formatSize(642)).toBe("642 B");
  });

  test("1024 and above print as N.N KB", () => {
    expect(formatSize(1536)).toBe("1.5 KB");
  });

  test("1024 * 1024 and above print as N.N MB", () => {
    expect(formatSize(1572864)).toBe("1.5 MB");
  });

  test("exactly 1MB prints as MB, not four-digit KB", () => {
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
  });
});

describe("buildFileType", () => {
  test("classifies html, css, js/mjs; everything else is undefined", () => {
    expect(buildFileType("index.html")).toBe("html");
    expect(buildFileType("assets/a.css")).toBe("css");
    expect(buildFileType("assets/a.js")).toBe("js");
    expect(buildFileType("assets/a.mjs")).toBe("js");
    expect(buildFileType("assets/a.png")).toBeUndefined();
  });
});
