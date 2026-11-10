// bun run test           # the Mac app
// bun run test --both    # the Mac app, then a browser tab
import { expect } from "bun:test";
import { join } from "node:path";
import { describeApp, test } from "steambun/test";

const OPS = [
  "haptic.tap",
  "share.text",
  "ai.available",
  "ai.steps",
  "remind.set",
  "remind.cancel",
  "settings.open",
];

describeApp({ root: join(import.meta.dir, ".."), ready: "#add" }, (app) => {
  // `glass` in package.json: real glass behind the page, in the Mac app only.
  test("the page knows when glass is behind it", async () => {
    expect(await app.js(`"glass" in document.documentElement.dataset`)).toBe(
      app.native,
    );
  });

  // native/bridge.ts: the app's own ops, in the Mac app only.
  test("the app's ops exist only in the Mac app", async () => {
    const has = `${JSON.stringify(OPS)}.map((o) => window.__steambun?.ops.includes(o) ?? false)`;
    expect(await app.js(has)).toEqual(OPS.map(() => app.native));
  });

  // SF Symbols in the Mac app (SymbolScheme.swift); SVGs in a tab.
  test("icons are SF Symbols in the Mac app and SVGs in a tab", async () => {
    const src = await app.js(
      `getComputedStyle(document.querySelector("#gear .icon")).getPropertyValue("--icon")`,
    );
    expect(src).toContain(
      app.native ? "sf-symbol:gearshape" : "data:image/svg",
    );
    if (!app.native) return;
    // The shell draws a known symbol and refuses an unknown one.
    const load = (name: string) =>
      app.eval(`
        const i = new Image();
        i.src = "sf-symbol:${name}?size=20";
        return await new Promise((r) => {
          i.onload = () => r(i.naturalWidth);
          i.onerror = () => r(0);
        });`);
    expect(await load("checklist")).toBeGreaterThan(20);
    expect(await load("no.such.symbol")).toBe(0);
  });

  // An async op checks its args at the call, before the model starts.
  test("an async op rejects bad args at once", async () => {
    if (!app.native) return;
    const err = await app.eval(`
      try { await window.webkit.messageHandlers.steambun.postMessage({ op: "ai.steps", args: {} }); return ""; }
      catch (e) { return String(e.message ?? e); }`);
    expect(err).not.toBe("");
  });

  test("adding a to-do updates the list and the menu bar", async () => {
    await app.click("#text");
    await app.type("Buy milk");
    await app.key("Enter");
    expect(await app.text("#list .todo .title")).toBe("Buy milk");
    expect(await app.text("#count")).toBe("1");
    if (app.native) await app.until((s) => s.menuBar === "1" && s.panel);
  });

  test("checking it off clears the title", async () => {
    await app.js(
      `(window.__errs = [], addEventListener("unhandledrejection", (e) => __errs.push(String(e.reason))), 1)`,
    );
    await app.click("#list .check");
    // The Mac app taps the trackpad; a tab skips it without an error.
    expect(await app.js(`__errs.length`)).toBe(0);
    expect(await app.text("#done-count")).toBe("1 Completed");
    if (app.native) await app.until((s) => s.menuBar === "");
  });

  test("the list survives a relaunch", async () => {
    await app.relaunch();
    await app.waitFor(`document.querySelector("#list .todo")`);
    expect(
      await app.js(
        `document.querySelectorAll('#list .check[aria-checked="true"]').length`,
      ),
    ).toBe(1);
  });

  // Steps come from the model in the Mac app; here they're set by hand.
  test("the last step done finishes the to-do", async () => {
    const todo = {
      id: "s",
      text: "Plan a picnic",
      done: false,
      steps: [
        { text: "Pick a park", done: true },
        { text: "Pack lunch", done: false },
      ],
    };
    await app.js(
      `(localStorage.setItem("todos", ${JSON.stringify(JSON.stringify([todo]))}), location.reload(), 1)`,
    );
    await app.waitFor(`document.querySelectorAll("#list .step").length === 2`);
    await app.click("#list .step:last-child .check");
    await app.waitFor(`document.querySelector("#list .todo.done")`);
    expect(await app.text("#count")).toBe("0");
  });

  // In a tab, settings are a dialog; in the Mac app, a SwiftUI window.
  test("hiding completed to-dos hides them", async () => {
    if (app.native) {
      await app.click("#toggle-done");
    } else {
      await app.click("#gear");
      await app.waitFor(`document.querySelector("dialog[open]")`);
      await app.click(`[name="showCompleted"]`);
      await app.key("Escape");
    }
    await app.waitFor(`!document.querySelector("#list .todo.done")`);
    expect(await app.text("#toggle-done")).toBe("Show");
    expect(
      await app.js(
        `JSON.parse(localStorage.getItem("settings")).showCompleted`,
      ),
    ).toBe(false);
  });

  test("Escape hides the panel", async () => {
    if (!app.native) return;
    await app.key("Escape");
    await app.until((s) => !s.panel);
  });
});
