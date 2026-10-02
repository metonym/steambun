import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = join(import.meta.dir, "..", "src", "bin.ts");
const root = mkdtempSync(join(tmpdir(), "steambun-bin-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

mkdirSync(join(root, ".steambun"));
writeFileSync(
  join(root, ".steambun", "metafile.json"),
  JSON.stringify({ inputs: {}, outputs: {} }),
);

async function run(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn({
    cmd: ["bun", bin, ...args],
    cwd: root,
    env: { ...process.env, STEAMBUN_DEBUG: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stderr, exitCode };
}

// ENOENT from reading the baseline is not a [steambun] error.
const unexpected = ["analyze", "--root", root, "--compare", "missing.json"];

test("unexpected errors print only the message by default", async () => {
  const { stderr, exitCode } = await run(unexpected);
  expect(exitCode).toBe(1);
  expect(stderr).not.toContain("\n    at ");
});

test("STEAMBUN_DEBUG prints the stack for unexpected errors", async () => {
  const { stderr, exitCode } = await run(unexpected, { STEAMBUN_DEBUG: "1" });
  expect(exitCode).toBe(1);
  expect(stderr).toContain("\n    at ");
});

test("[steambun] errors never print a stack", async () => {
  const { stderr, exitCode } = await run(["bulid"], { STEAMBUN_DEBUG: "1" });
  expect(exitCode).toBe(1);
  expect(stderr.trim()).toBe('[steambun] unknown command "bulid"');
});

test("bin skips Bun's .env autoload so .env.[mode] can override .env", async () => {
  const shebang = (await Bun.file(bin).text()).split("\n")[0];
  expect(shebang).toContain("--no-env-file");
});
