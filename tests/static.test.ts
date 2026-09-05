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

  test("HEAD returns the same headers with no body", async () => {
    const handler = createStaticHandler({ outDir, spa: false });
    const res = await handler(
      new Request("http://localhost/foo.txt", { method: "HEAD" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeTruthy();
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
    expect(await res.text()).toBe("console.log(1)");
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

describe("createStaticHandler — headersFile", () => {
  test("applies a matching glob's headers from _headers.json", async () => {
    const outDir = fixtureDir();
    writeFileSync(
      join(outDir, "_headers.json"),
      JSON.stringify({
        "/*.html": {
          "Content-Security-Policy": "default-src 'self'",
          "x-custom": "html",
        },
        "/foo.txt": { "x-custom": "txt" },
      }),
    );

    const handler = createStaticHandler({
      outDir,
      spa: false,
      headersFile: join(outDir, "_headers.json"),
    });

    const htmlRes = await handler(new Request("http://localhost/about"));
    expect(htmlRes.headers.get("content-security-policy")).toBe(
      "default-src 'self'",
    );
    expect(htmlRes.headers.get("x-custom")).toBe("html");

    const txtRes = await handler(new Request("http://localhost/foo.txt"));
    expect(txtRes.headers.get("x-custom")).toBe("txt");
    expect(txtRes.headers.get("content-security-policy")).toBeNull();
  });

  test("a missing headersFile is a no-op", async () => {
    const outDir = fixtureDir();
    const handler = createStaticHandler({
      outDir,
      spa: false,
      headersFile: join(outDir, "no-such-file.json"),
    });
    const res = await handler(new Request("http://localhost/foo.txt"));
    expect(res.status).toBe(200);
  });
});
