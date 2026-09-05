import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../src/build/build";
import { resolveDefaults } from "../src/config/loader";
import { createApp } from "../src/runtime/app";
import { splitPlugins } from "../src/util/plugins";

describe("splitPlugins", () => {
  test("throws for a plugin with no recognized shape", () => {
    expect(() => splitPlugins([{ typo: () => {} } as never])).toThrow(
      "[steambun] Unrecognized plugin at index 0",
    );
  });

  test("accepts a Bun plugin and a steambun hooks object", () => {
    const { bunPlugins, hooks } = splitPlugins([
      { name: "bun-plugin", setup() {} },
      { onBuildEnd() {} },
    ]);
    expect(bunPlugins).toHaveLength(1);
    expect(hooks).toHaveLength(1);
  });
});

describe("build() hook call order", () => {
  test("configResolved, buildStart, transformHtml, onBuildEnd, closeBundle", async () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-hooks-"));
    writeFileSync(
      join(root, "index.html"),
      "<!doctype html><html><body>hi</body></html>\n",
    );
    const logPath = join(root, "calls.json");
    writeFileSync(logPath, "[]");
    writeFileSync(
      join(root, "steambun.config.ts"),
      `import { readFileSync, writeFileSync } from "node:fs";
const logPath = ${JSON.stringify(logPath)};
function log(name) {
  const calls = JSON.parse(readFileSync(logPath, "utf8"));
  calls.push(name);
  writeFileSync(logPath, JSON.stringify(calls));
}
export default {
  build: { server: false },
  plugins: [
    {
      configResolved() { log("configResolved"); },
      buildStart() { log("buildStart"); },
      transformHtml(html) { log("transformHtml"); return html; },
      onBuildEnd() { log("onBuildEnd"); },
      closeBundle() { log("closeBundle"); },
    },
  ],
};
`,
    );

    await build({ root });

    const calls = JSON.parse(readFileSync(logPath, "utf8"));
    expect(calls).toEqual([
      "configResolved",
      "buildStart",
      "transformHtml",
      "onBuildEnd",
      "closeBundle",
    ]);
  });
});

describe("createApp configureApp hook", () => {
  test("adds a route observable via app.fetch, before serveOptions is built", async () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-hooks-app-"));
    const config = resolveDefaults(
      {
        publicDir: false,
        plugins: [
          {
            configureApp(app: { routes: Record<string, unknown> }) {
              app.routes["/hooked"] = () => new Response("from hook");
            },
          },
        ],
      },
      { root, command: "dev", mode: "development", configFile: null },
    );

    const app = await createApp({ config, mode: "dev" });
    const res = await app.fetch(new Request("http://localhost/hooked"));
    expect(await res.text()).toBe("from hook");
  });
});
