// steambun's `test` gives app tests more time than bun's 5 s default: a
// relaunch on a slow CI runner can take that long alone.
import { expect, test } from "bun:test";
import { join } from "node:path";

test("a steambun test can run past 5 s", async () => {
  const p = Bun.spawn(
    ["bun", "test", join(import.meta.dir, "fixtures/slow.fixture.ts")],
    { stdout: "pipe", stderr: "pipe" },
  );
  const err = await new Response(p.stderr).text();
  expect(await p.exited, err).toBe(0);
}, 15_000);
