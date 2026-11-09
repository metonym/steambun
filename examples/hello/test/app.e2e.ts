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
});
