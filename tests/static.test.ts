import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../src/build/build";
import { resolveDefaults } from "../src/config/loader";
import { createApp } from "../src/runtime/app";
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
  writeFileSync(join(dir, "my file.png"), "png-bytes");
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

  test("percent-encoded filename with a space is served", async () => {
    const res = await spa(new Request("http://localhost/my%20file.png"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("png-bytes");
  });

  test("malformed percent-encoding is a 400", async () => {
    const res = await spa(new Request("http://localhost/%"));
    expect(res.status).toBe(400);
  });

  test("a decoded path with a .. segment is 404, not a file outside outDir", async () => {
    const res = await noSpa(
      new Request("http://localhost/..%2f..%2fetc/passwd"),
    );
    expect(res.status).toBe(404);
  });

  test("traversal never reaches a real file beside outDir, even with spa or a base", async () => {
    const parent = mkdtempSync(join(tmpdir(), "steambun-static-escape-"));
    writeFileSync(join(parent, "secret.txt"), "secret");
    const dist = join(parent, "dist");
    mkdirSync(dist);
    writeFileSync(join(dist, "index.html"), "<h1>spa</h1>");
    const handlers = [
      createStaticHandler({ outDir: dist, spa: true }),
      createStaticHandler({ outDir: dist, spa: true, base: "/app/" }),
    ];
    // URL parsing already collapses %2e%2e, so those fall back to the SPA page; %2f survives to the decoder and is a 404.
    for (const path of [
      "/%2e%2e/secret.txt",
      "/..%2fsecret.txt",
      "/a/..%2f..%2fsecret.txt",
      "/app/..%2fsecret.txt",
    ]) {
      for (const handler of handlers) {
        const res = await handler(new Request(`http://localhost${path}`));
        expect(await res.text()).not.toContain("secret");
      }
    }
    const res = await handlers[0]?.(
      new Request("http://localhost/..%2fsecret.txt"),
    );
    expect(res?.status).toBe(404);
  });

  test("a backslash can't smuggle a .. segment (a separator on Windows)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-static-backslash-"));
    writeFileSync(join(dir, "..\\secret.txt"), "secret");
    const handler = createStaticHandler({ outDir: dir, spa: false });
    for (const path of ["/..%5csecret.txt", "/a%5c..%5c..%5csecret.txt"]) {
      const res = await handler(new Request(`http://localhost${path}`));
      expect(res.status).toBe(404);
    }
  });

  test("an excluded path is never served, however it is spelled", async () => {
    const dir = fixtureDir();
    writeFileSync(join(dir, "server.js"), "SECRET");
    for (const spaFallback of [true, false]) {
      const handler = createStaticHandler({
        outDir: dir,
        spa: spaFallback,
        exclude: ["server.js"],
      });
      for (const path of [
        "/server.js",
        "/server.js/",
        "/SERVER.JS",
        "/%73erver.js",
        "//server.js",
      ]) {
        const res = await handler(new Request(`http://localhost${path}`));
        expect(await res.text()).not.toContain("SECRET");
      }
      expect(
        (await handler(new Request("http://localhost/foo.txt"))).status,
      ).toBe(200);
    }
  });

  test("a double-encoded .. is a literal name, not a traversal", async () => {
    const res = await noSpa(new Request("http://localhost/%252e%252e/foo.txt"));
    expect(res.status).toBe(404);
  });

  test("a path containing %00 is 404", async () => {
    const res = await noSpa(new Request("http://localhost/foo.txt%00.png"));
    expect(res.status).toBe(404);
  });

  test("a sibling `dup.html` file wins over `dup/index.html` for path 'dup'", async () => {
    const dir = fixtureDir();
    mkdirSync(join(dir, "dup"));
    writeFileSync(join(dir, "dup", "index.html"), "<h1>dir-index</h1>");
    writeFileSync(join(dir, "dup.html"), "<h1>dup-file</h1>");
    const handler = createStaticHandler({ outDir: dir, spa: false });
    const res = await handler(new Request("http://localhost/dup"));
    expect(await res.text()).toContain("dup-file");
  });
});

describe("createStaticHandler — headers", () => {
  const outDir = fixtureDir();

  test("HTML always gets no-cache, even under immutablePrefix", async () => {
    const handler = createStaticHandler({
      outDir,
      spa: true,
      immutablePrefix: "/",
    });
    const res = await handler(new Request("http://localhost/about"));
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("immutablePrefix gives long-lived caching for matching paths", async () => {
    const handler = createStaticHandler({
      outDir,
      spa: false,
      immutablePrefix: "/foo",
    });
    const res = await handler(new Request("http://localhost/foo.txt"));
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(res.headers.get("etag")).toBeNull();
  });

  test("non-immutable files get a weak ETag and 304 on If-None-Match", async () => {
    const handler = createStaticHandler({ outDir, spa: false });
    const first = await handler(new Request("http://localhost/foo.txt"));
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^W\//);

    const second = await handler(
      new Request("http://localhost/foo.txt", {
        headers: { "if-none-match": etag! },
      }),
    );
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  test("If-None-Match accepts comma lists, weak validators, and *", async () => {
    const handler = createStaticHandler({ outDir, spa: false });
    const etag = (
      await handler(new Request("http://localhost/foo.txt"))
    ).headers.get("etag")!;
    const bare = etag.replace(/^W\//, "");
    const status = async (value: string) =>
      (
        await handler(
          new Request("http://localhost/foo.txt", {
            headers: { "if-none-match": value },
          }),
        )
      ).status;

    expect(await status(`"other", ${etag}`)).toBe(304);
    expect(await status(`${etag},"other"`)).toBe(304);
    expect(await status(bare)).toBe(304);
    expect(await status(`W/"other", ${bare}`)).toBe(304);
    expect(await status("*")).toBe(304);
    expect(await status(`"other", W/"another"`)).toBe(200);
    expect(await status("")).toBe(200);
  });

  test("HEAD returns the same headers with no body", async () => {
    const handler = createStaticHandler({ outDir, spa: false });
    const res = await handler(
      new Request("http://localhost/foo.txt", { method: "HEAD" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeTruthy();
    expect(res.headers.get("content-length")).toBe(
      String(Bun.file(join(outDir, "foo.txt")).size),
    );
    expect(await res.text()).toBe("");
  });
});

describe("createStaticHandler — precompressed variants", () => {
  const outDir = fixtureDir();
  writeFileSync(join(outDir, "app.js"), "console.log(1)");
  writeFileSync(join(outDir, "app.js.br"), "brotli-bytes");
  writeFileSync(join(outDir, "app.js.gz"), "gzip-bytes");

  test("Accept-Encoding: br returns the .br sibling with matching headers", async () => {
    const handler = createStaticHandler({ outDir, spa: false });
    const res = await handler(
      new Request("http://localhost/app.js", {
        headers: { "accept-encoding": "gzip, br" },
      }),
    );
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toBe("brotli-bytes");
  });

  test("no Accept-Encoding returns the original file", async () => {
    const handler = createStaticHandler({ outDir, spa: false });
    const res = await handler(new Request("http://localhost/app.js"));
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(await res.text()).toBe("console.log(1)");
  });

  test("a 304 for a file with variants still carries Vary", async () => {
    const handler = createStaticHandler({ outDir, spa: false });
    const etag = (
      await handler(new Request("http://localhost/app.js"))
    ).headers.get("etag")!;
    const res = await handler(
      new Request("http://localhost/app.js", {
        headers: { "if-none-match": etag },
      }),
    );
    expect(res.status).toBe(304);
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
  });

  test("precompressed: false ignores Accept-Encoding entirely", async () => {
    const handler = createStaticHandler({
      outDir,
      spa: false,
      precompressed: false,
    });
    const res = await handler(
      new Request("http://localhost/app.js", {
        headers: { "accept-encoding": "br" },
      }),
    );
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  test("Accept-Encoding lists zstd and br first but only the gzip sibling exists", async () => {
    writeFileSync(join(outDir, "gzip-only.js"), "console.log(2)");
    writeFileSync(join(outDir, "gzip-only.js.gz"), "gzip-only-bytes");
    const handler = createStaticHandler({ outDir, spa: false });
    const res = await handler(
      new Request("http://localhost/gzip-only.js", {
        headers: { "accept-encoding": "zstd, br;q=0.9, gzip" },
      }),
    );
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(await res.text()).toBe("gzip-only-bytes");
  });
});

describe("build() + createApp preview — precompress round trip", () => {
  test("a gzip-precompressed asset is served through the preview static handler", async () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-precompress-build-"));
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "index.html"),
      `<!doctype html><html><body><script type="module" src="./src/main.ts"></script></body></html>\n`,
    );
    writeFileSync(
      join(root, "src", "main.ts"),
      `console.log(${JSON.stringify("hello ".repeat(200))});\n`,
    );
    const buildConfig: {
      precompress: Array<"gzip" | "br" | "zstd">;
      precompressMinSize: number;
      server: boolean;
    } = {
      precompress: ["gzip"],
      precompressMinSize: 10,
      server: false,
    };
    writeFileSync(
      join(root, "steambun.config.ts"),
      `export default { build: ${JSON.stringify(buildConfig)} };\n`,
    );

    await build({ root });

    const outDir = join(root, "dist");
    const assetsDir = join(outDir, "assets");
    const jsFile = readdirSync(assetsDir).find((f) => f.endsWith(".js"));
    expect(jsFile).toBeDefined();
    expect(await Bun.file(join(assetsDir, `${jsFile}.gz`)).exists()).toBe(true);

    const config = resolveDefaults(
      { build: buildConfig },
      { root, command: "preview", mode: "production", configFile: null },
    );
    const app = await createApp({ config, mode: "preview", outDir });

    const res = await app.fetch(
      new Request(`http://localhost/assets/${jsFile}`, {
        headers: { "accept-encoding": "gzip" },
      }),
    );
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    const decompressed = Bun.gunzipSync(
      new Uint8Array(await res.arrayBuffer()),
    );
    expect(new TextDecoder().decode(decompressed)).toContain("hello");
  });
});

describe("createStaticHandler — build metadata", () => {
  test("manifest.json is served", async () => {
    const outDir = fixtureDir();
    writeFileSync(join(outDir, "manifest.json"), '{"ok":true}');
    const handler = createStaticHandler({ outDir, spa: false });
    const res = await handler(new Request("http://localhost/manifest.json"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
  });
});

describe("createStaticHandler — resolution cache", () => {
  test("cache (default true) reuses the resolved entry across requests", async () => {
    const outDir = fixtureDir();
    const file = join(outDir, "cached.txt");
    writeFileSync(file, "v1");
    const handler = createStaticHandler({ outDir, spa: false });

    const first = await handler(new Request("http://localhost/cached.txt"));
    const etag1 = first.headers.get("etag");
    expect(etag1).toBeTruthy();

    // outDir is immutable for the handler's lifetime, so the etag stays put.
    await new Promise((r) => setTimeout(r, 5));
    writeFileSync(file, "v1-is-now-a-longer-string");
    const second = await handler(new Request("http://localhost/cached.txt"));
    expect(second.headers.get("etag")).toBe(etag1);
  });

  test("cache: false re-resolves (and re-stats) from disk on every request", async () => {
    const outDir = fixtureDir();
    const file = join(outDir, "live.txt");
    writeFileSync(file, "v1");
    const handler = createStaticHandler({ outDir, spa: false, cache: false });

    const first = await handler(new Request("http://localhost/live.txt"));
    const etag1 = first.headers.get("etag");

    await new Promise((r) => setTimeout(r, 5));
    writeFileSync(file, "v1-is-now-a-longer-string");
    const second = await handler(new Request("http://localhost/live.txt"));
    expect(second.headers.get("etag")).not.toBe(etag1);
  });
});

describe("createStaticHandler base", () => {
  const outDir = fixtureDir();
  const based = createStaticHandler({ outDir, spa: true, base: "/app/" });

  test("strips the base prefix before lookup", async () => {
    expect(
      await (await based(new Request("http://x/app/foo.txt"))).text(),
    ).toBe("hello");
    expect(
      await (await based(new Request("http://x/app/nested/"))).text(),
    ).toContain("dir");
    expect(await (await based(new Request("http://x/app"))).text()).toContain(
      "spa",
    );
  });

  test("still serves paths outside the base", async () => {
    expect(await (await based(new Request("http://x/foo.txt"))).text()).toBe(
      "hello",
    );
  });
});

describe("createStaticHandler accept-encoding q=0", () => {
  test("an encoding refused with q=0 is not served", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "steambun-static-q-"));
    writeFileSync(join(outDir, "a.txt"), "plain");
    writeFileSync(join(outDir, "a.txt.gz"), Bun.gzipSync("plain"));
    const handler = createStaticHandler({ outDir, spa: false });
    const refused = handler(
      new Request("http://x/a.txt", {
        headers: { "accept-encoding": "gzip;q=0, identity" },
      }),
    );
    expect(refused.headers.get("content-encoding")).toBeNull();
    const accepted = handler(
      new Request("http://x/a.txt", {
        headers: { "accept-encoding": "gzip;q=0.5" },
      }),
    );
    expect(accepted.headers.get("content-encoding")).toBe("gzip");
  });
});

test("a missing asset-like path is 404 even with spa; extensionless paths still fall back", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "steambun-spa-asset-"));
  writeFileSync(join(outDir, "index.html"), "<h1>shell</h1>");
  const handler = createStaticHandler({ outDir, spa: true });
  expect(
    (await handler(new Request("http://localhost/assets/x.js"))).status,
  ).toBe(404);
  expect(
    (await handler(new Request("http://localhost/deep/route"))).status,
  ).toBe(200);
});
