// The build side, in process: what every `steambun` command pays before
// it does its real work, and what `steambun check` and `gen` cost.
import { join } from "node:path";
import { group, task } from "ostia";
import bridge from "../examples/native-op/native/bridge.ts";
import { check, pageEntries } from "../src/check.ts";
import { loadConfigSync } from "../src/config.ts";
import { appSwift, frameworkSwift } from "../src/gen/bridge.ts";
import { configSwift, infoPlist } from "../src/gen/config.ts";
import { parseChord } from "../src/test.ts";

const ex = (name: string) => join(import.meta.dir, "../examples", name);
const hello = loadConfigSync(ex("hello"));
const core = loadConfigSync(ex("core"));
const nativeOp = loadConfigSync(ex("native-op"));

group("config", () => {
  task("load package.json config", () => loadConfigSync(ex("todo-bar")));
  task("load defaults", () => loadConfigSync(ex("hello")));
});

group("check", () => {
  task("page only (hello)", () => check(hello));
  task("core and React page (core)", () => check(core));
  task("page entries (core)", () => pageEntries(core));
});

group("gen", () => {
  task("framework Swift", () => frameworkSwift());
  task("app Swift (native-op)", () => appSwift(bridge, "native/bridge.ts"));
  task("config Swift (native-op)", () => configSwift(nativeOp));
  task("Info.plist", () =>
    infoPlist(hello, {
      version: "1.0.0",
      build: "1",
      updateURL: "",
      updateKey: "",
    }),
  );
});

group("test harness", () => {
  task("parse a chord", () => parseChord("mod+shift+k"));
});
