// bun run test   (the Mac app only: a tab has no Swift)
import { join } from "node:path";
import { describeApp, test } from "steambun/test";

const played = (n: number) =>
  `document.getElementById("played").textContent === "played ${n}×"`;

describeApp(
  { root: join(import.meta.dir, ".."), ready: "#play" },
  (app) => {
    test("the button calls Swift", async () => {
      if (!app.native) return;
      await app.click("#play");
      await app.waitFor(played(1));
    });

    test("the menu's key does too", async () => {
      if (!app.native) return;
      await app.key("mod+shift+p");
      await app.waitFor(played(2));
    });
  },
);
