// bun run test           # the Mac app
// bun run test --both    # the Mac app, then a browser tab
import { join } from "node:path";
import { describeApp, test } from "steambun/test";

const h1 = (n: number) => `document.querySelector("h1").textContent === "${n}"`;

describeApp({ root: join(import.meta.dir, ".."), ready: "button" }, (app) => {
  test("the page reads the core", () => app.waitFor(h1(0)));

  test("the core counts", async () => {
    await app.click("button");
    await app.waitFor(h1(1));
  });

  test("the count survives a relaunch", async () => {
    await app.relaunch();
    await app.waitFor(h1(1));
  });
});
