import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticHandler } from "../src/runtime/static";

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "steambun-static-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><h1>spa</h1>");
  writeFileSync(join(dir, "foo.txt"), "hello");
  writeFileSync(join(dir, "empty.txt"), "");
  mkdirSync(join(dir, "nested"));
  writeFileSync(
    join(dir, "nested", "index.html"),
    "<!doctype html><h1>dir</h1>",
  );
  writeFileSync(join(dir, "about.html"), "<!doctype html><h1>about</h1>");
  return dir;
}

describe("createStaticHandler", () => {
  const outDir = fixtureDir();
  const spa = createStaticHandler({ outDir, spa: true });
  const noSpa = createStaticHandler({ outDir, spa: false });

  test("file at outDir/foo.txt returns that file", async () => {
    const res = await spa(new Request("http://localhost/foo.txt"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });

  test("directory path serves dir/index.html", async () => {
    const res = await spa(new Request("http://localhost/nested/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("dir");
  });

  test("html file is served at its route without the extension", async () => {
    const res = await spa(new Request("http://localhost/about"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("about");
  });

  test("trailing slash still finds the html file before SPA fallback", async () => {
    const res = await spa(new Request("http://localhost/about/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("about");
  });

  test("missing path with spa serves outDir/index.html", async () => {
    const res = await spa(new Request("http://localhost/app/route"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("spa");
  });

  test("missing path without spa is 404", async () => {
    const res = await noSpa(new Request("http://localhost/app/route"));
    expect(res.status).toBe(404);
  });

  test("empty file is served (size 0 is not missing)", async () => {
    const res = await spa(new Request("http://localhost/empty.txt"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  test("SPA fallback does not consume a cached Response body", async () => {
    const first = await spa(new Request("http://localhost/one"));
    const second = await spa(new Request("http://localhost/two"));
    expect(await first.text()).toContain("spa");
    expect(await second.text()).toContain("spa");
  });
});
