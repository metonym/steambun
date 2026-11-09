// bun run test           # the Mac app
// bun run test --both    # the Mac app, then a browser tab
import { expect } from "bun:test";
import { join } from "node:path";
import { describeApp, test } from "steambun/test";

describeApp(
  { root: join(import.meta.dir, ".."), ready: "#add" },
  (app) => {
    test("adding a to-do updates the list and the menu bar", async () => {
      await app.click("#text");
      await app.type("Buy milk");
      await app.key("Enter");
      expect(await app.text("#list li span")).toBe("Buy milk");
      if (app.native) await app.until((s) => s.menuBar === "1" && s.panel);
    });

    test("checking it off clears the title", async () => {
      await app.click("#list input");
      if (app.native) await app.until((s) => s.menuBar === "");
    });

    test("the list survives a relaunch", async () => {
      await app.relaunch();
      await app.waitFor(`document.querySelector("#list li")`);
      expect(
        await app.js(`document.querySelectorAll("#list :checked").length`),
      ).toBe(1);
    });

    test("Escape hides the panel", async () => {
      if (!app.native) return;
      await app.key("Escape");
      await app.until((s) => !s.panel);
    });
  },
);
