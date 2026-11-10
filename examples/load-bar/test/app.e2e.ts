// The menu bar app with a core. Runs on both backends:
//
//   bun run test           # the Mac app
//   bun run test --both    # the Mac app, then a browser tab
import { expect } from "bun:test";
import { join } from "node:path";
import { describeApp, launch, test } from "steambun/test";

const root = join(import.meta.dir, "..");
const sampled = (s: { menuBar: string }) => /^\d+\.\d$/.test(s.menuBar);

describeApp({ root, ready: "polyline[points]" }, (app) => {
  test("the page reads the core", async () => {
    expect(await app.text("#now")).toMatch(/^\d+\.\d\d$/);
  });

  test("the core sets the menu bar title", async () => {
    if (!app.native) return; // a tab has no menu bar
    await app.until(sampled);
  });

  test("the page waits for the first click", async () => {
    if (!app.native) return;
    const idle = await launch({ root, front: false });
    try {
      // The core runs and sets the title; no page has loaded.
      const s = await idle.until(sampled);
      expect(s.url).toBe("");
      expect(s.panel).toBe(false);
      // Opening the panel loads it.
      await idle.activate();
      await idle.waitPage("polyline[points]");
      expect((await idle.state()).panel).toBe(true);
    } finally {
      await idle.close();
    }
  });
});
