import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverHtmlEntries,
  discoverSkipDirs,
  htmlServePath,
} from "../src/dev/discover";

describe("discoverHtmlEntries", () => {
  test("maps root index.html to a catch-all and about.html to /about", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-html-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html>");
    writeFileSync(join(dir, "about.html"), "<!doctype html>");
    const entries = await discoverHtmlEntries(dir);
    expect(entries.map((e) => [e.routePath, e.isCatchAll])).toEqual([
      ["/about", false],
      ["/*", true],
    ]);
  });

  test("maps nested about/index.html to /about", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-html-nested-"));
    mkdirSync(join(dir, "about"));
    writeFileSync(join(dir, "index.html"), "<!doctype html>");
    writeFileSync(join(dir, "about", "index.html"), "<!doctype html>");
    const entries = await discoverHtmlEntries(dir);
    const byRoute = Object.fromEntries(
      entries.map((e) => [e.routePath, e.isCatchAll]),
    );
    expect(byRoute["/*"]).toBe(true);
    expect(byRoute["/about"]).toBe(false);
  });

  test("skips public, dist, node_modules, and dot directories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-html-skip-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html>");
    mkdirSync(join(dir, "public"));
    writeFileSync(join(dir, "public", "hidden.html"), "<!doctype html>");
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "out.html"), "<!doctype html>");
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules", "pkg", "x.html"),
      "<!doctype html>",
    );
    const entries = await discoverHtmlEntries(dir);
    expect(entries.map((e) => e.routePath)).toEqual(["/*"]);
  });

  test("skips a nested build.outDir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-html-nested-outdir-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html>");
    writeFileSync(join(dir, "about.html"), "<!doctype html>");
    mkdirSync(join(dir, "build", "output"), { recursive: true });
    writeFileSync(
      join(dir, "build", "output", "leftover.html"),
      "<!doctype html>",
    );
    const { skipDirs, skipPaths } = discoverSkipDirs({
      build: { outDir: "build/output" },
    });
    const entries = await discoverHtmlEntries(dir, { skipDirs, skipPaths });
    const routes = entries.map((e) => e.routePath);
    expect(routes).toContain("/about");
    expect(routes).toContain("/*");
    expect(routes).not.toContain("/build/output/leftover");
    expect(entries).toHaveLength(2);
  });
});

describe("htmlServePath", () => {
  const catchAll = { routePath: "/*", isCatchAll: true };
  const about = { routePath: "/about", isCatchAll: false };

  test("keeps root index as /* in spa and / in mpa", () => {
    expect(htmlServePath(catchAll, "spa")).toBe("/*");
    expect(htmlServePath(catchAll, "mpa")).toBe("/");
  });

  test("does not change named HTML routes", () => {
    expect(htmlServePath(about, "spa")).toBe("/about");
    expect(htmlServePath(about, "mpa")).toBe("/about");
  });
});
