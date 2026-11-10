// What `steambun build` and `steambun app` cost, in process. Each writes to
// build/bench in its example, so the examples' own builds stay as they are.
// The slow ones take a few samples: one shell build is seconds of swiftc.
import { join } from "node:path";
import { group, task } from "ostia";
import { loadConfigSync } from "../src/config.ts";
import { app, build, buildWeb } from "../src/tools.ts";

const ex = (name: string) => ({
  ...loadConfigSync(join(import.meta.dir, "../examples", name)),
  out: "build/bench",
});
const hello = ex("hello");
const core = ex("core");

// The shell build needs a built page or core to bundle.
await build(hello);

const SLOW = { samples: 5 };

group("bundle", () => {
  task("page, no core (hello)", () => build(hello));
  task("static site, React (core)", () => buildWeb(core));
  task("core as plain JS, system Bun (core)", () =>
    build({ ...core, bun: "system" }),
  );
  task("core, JIT binary (core)", () => build(core, { aot: false }), SLOW);
  task("core, AOT binary (core)", () => build(core), SLOW);
});

group("shell", () => {
  task("swiftc, sign, bundle (hello)", () => app(hello), SLOW);
});
