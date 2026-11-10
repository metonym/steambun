// Real apps: launch to a ready page, the harness's round trips, and the
// page's calls into the shell. Needs macOS and the examples' shells
// (`bun run test:e2e` builds them). Each launch is a hidden app.
import { join } from "node:path";
import { group, task } from "ostia";
import { type App, type Backend, launch, whyNot } from "../src/test.ts";

const root = (name: string) => join(import.meta.dir, "../examples", name);
const LAUNCH = { samples: 12 };

const why = await whyNot({ root: root("hello") });
if (why) throw new Error(`app bench can't run: ${why}`);

/** One app for a group's tasks. */
function withApp(dir: string, backend: Backend, ready: string) {
  let app: App;
  return {
    get: () => app,
    hooks: {
      before: async () => {
        app = await launch({ root: dir, backend, ready });
      },
      after: () => app.close(),
    },
  };
}

const once = (name: string, backend: Backend, ready: string) => async () => {
  const app = await launch({ root: root(name), backend, ready });
  await app.close();
};

group("launch to ready page", () => {
  task("hello, Mac app", once("hello", "native", "h1"), LAUNCH);
  task("hello, tab", once("hello", "tab", "h1"), LAUNCH);
  task("core (Bun core, React), Mac app", once("core", "native", "h1"), LAUNCH);
  task("core (Bun core, React), tab", once("core", "tab", "h1"), LAUNCH);
  task(
    "todo-bar (menu bar), Mac app",
    once("todo-bar", "native", "body"),
    LAUNCH,
  );
});

for (const backend of ["native", "tab"] as const) {
  const a = withApp(root("hello"), backend, "h1");
  group(
    `round trip, ${backend === "native" ? "Mac app" : "tab"}`,
    () => {
      task("js", () => a.get().js("1"));
      task("text of an element", () => a.get().text("h1"));
      task("key press", () => a.get().key("x"));
      task("click", () => a.get().click({ x: 5, y: 5 }));
      task("screenshot", () => a.get().screenshot(), { samples: 30 });
    },
    a.hooks,
  );
}

{
  const a = withApp(root("hello"), "native", "h1");
  group(
    "shell",
    () => {
      task("state", () => a.get().state());
      // In the page: 100 bridge calls in a row, then one harness round trip.
      task("page → shell op, 100 calls", () =>
        a.get().eval(`
          const h = window.webkit.messageHandlers.steambun;
          for (let i = 0; i < 100; i++) await h.postMessage({ op: "app.info", args: {} });
          return 1;`),
      );
    },
    a.hooks,
  );
}
