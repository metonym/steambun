import { afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLogLevel } from "../src/util/terminal";

// Every fixture a test creates under os.tmpdir() lands here and is removed after the run.
const scratch = mkdtempSync(join(tmpdir(), "steambun-test-"));
process.env.TMPDIR = scratch;
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Variables steambun reads must not leak in from the developer's shell.
for (const key of [
  "STEAMBUN_DEBUG",
  "STEAMBUN_FEATURES",
  "PORT",
  "HOST",
  "STRICT_PORT",
  "OPEN",
]) {
  delete process.env[key];
}

// `main()` sets the log level and exit code for the whole process; a leaked exit code fails `bun test` itself.
afterEach(() => {
  setLogLevel("info");
  process.exitCode = 0;
});

// Tests that assert on output spy on console themselves; set STEAMBUN_TEST_VERBOSE=1 to see everything.
if (!process.env.STEAMBUN_TEST_VERBOSE) {
  for (const method of ["log", "info", "warn", "error"] as const) {
    console[method] = () => {};
  }
}
