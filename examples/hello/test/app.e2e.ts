// bun run test           # the Mac app
// bun run test --both    # the Mac app, then a browser tab
import { expect } from "bun:test";
import { join } from "node:path";
import { describeApp, test } from "steambun/test";

describeApp({ root: join(import.meta.dir, ".."), ready: "h1" }, (app) => {
  test("the page knows where it runs", async () => {
    const where = app.native
      ? /^In the Mac app, at \d+ Hz\.$/
      : /^In a browser tab\.$/;
    await app.waitFor(
      `${where}.test(document.getElementById("where").textContent)`,
    );
    expect(await app.text("h1")).toBe("Hello, world");
  });

  // A hot reload can land while waitFor polls the page.
  test("waitFor outlasts a reload", async () => {
    // Mark this page and reload it soon. Only the new page passes.
    await app.js(
      "(window.oldPage = true, setTimeout(() => location.reload(), 100))",
    );
    expect(
      await app.waitFor(`!window.oldPage && document.querySelector("h1")`),
    ).toBe(true);
    // A real error still fails at once, with no wait for the timeout.
    const t = performance.now();
    await expect(app.waitFor("(")).rejects.toThrow();
    expect(performance.now() - t).toBeLessThan(2000);
  });

  // A quit right after a write, as ⌘Q after an edit, must keep it. In a
  // tab, relaunch reloads the page; in the Mac app, it quits the shell.
  test("localStorage written just before a quit survives it", async () => {
    for (let i = 1; i <= 5; i++) {
      await app.js(`(localStorage.setItem("n", "${i}"), 1)`);
      await app.relaunch();
      expect(await app.js(`localStorage.getItem("n")`)).toBe(String(i));
    }
  });
});
