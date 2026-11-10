// `steambun build --web`: the page alone, as a static site that runs in
// a browser with no shell and no core.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { buildWeb } from "../src/tools.ts";

const ex = (name: string) => join(import.meta.dir, "../examples", name);

/** Serve a folder as static files and return the page's text. */
async function open(dir: string, expr: string) {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const p = new URL(req.url).pathname;
      const f = Bun.file(join(dir, p === "/" ? "index.html" : p));
      return (await f.exists())
        ? new Response(f)
        : new Response("", { status: 404 });
    },
  });
  const view = new Bun.WebView({ width: 800, height: 600 });
  try {
    await view.navigate(server.url.href);
    return await view.evaluate(`(async () => {
      for (const end = performance.now() + 5000; performance.now() < end; ) {
        const v = ${expr};
        if (v) return v;
        await new Promise((r) => setTimeout(r, 20));
      }
    })()`);
  } finally {
    view.close();
    server.stop();
  }
}

test("a page with no core runs as a static site", async () => {
  const c = await loadConfig(ex("hello"));
  await buildWeb(c);
  const text = await open(
    join(c.root, "build/web"),
    `document.querySelector("#where")?.textContent`,
  );
  expect(text).toBe("In a browser tab.");
}, 20_000);

test("with a core, it builds the HTML the core serves", async () => {
  const c = await loadConfig(ex("core"));
  await buildWeb(c);
  // The page renders; its count stays "…", since no core answers /api.
  const text = await open(
    join(c.root, "build/web"),
    `document.querySelector("button")?.textContent`,
  );
  expect(text).toBe("Count");
}, 20_000);
