// Run by tests/timeout.test.ts: a test past bun's 5 s default timeout.
import { test } from "../../src/test.ts";

test("outlasts bun's default timeout", async () => {
  await Bun.sleep(5_500);
});
