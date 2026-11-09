// The smallest steambun app: one page, no config, no core, no Swift.
// The same page runs in a browser tab and in the Mac app.
import { native } from "steambun/ui";

// The shell sends the screen's refresh rate. A tab never does.
native.watch("screen.hz", ({ hz }) => {
  document.getElementById("where")!.textContent =
    `In the Mac app, at ${hz} Hz.`;
});
