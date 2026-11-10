// bun run test
import { join } from "node:path";
import { describeApp, test } from "steambun/test";

const played = (n: number) =>
  `document.getElementById("played").textContent === "played ${n}×"`;

describeApp({ root: join(import.meta.dir, ".."), ready: "#play" }, (app) => {
  // Swift in the Mac app; Web Audio in a tab, which has no Swift.
  test("the button plays a sound", async () => {
    await app.click("#play");
    await app.waitFor(played(1));
  });

  // A tab has no menu bar.
  test("the menu's key does too", async () => {
    if (!app.native) return;
    await app.key("mod+shift+p");
    await app.waitFor(played(2));
  });
});
