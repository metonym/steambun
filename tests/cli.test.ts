import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../src/cli.ts";

const CLI = join(import.meta.dir, "../src/cli.ts");
const APP = join(import.meta.dir, "../examples/hello");
const empty = mkdtempSync(join(tmpdir(), "steambun-cli-"));
afterAll(() => rmSync(empty, { recursive: true, force: true }));

/** Run the CLI as an agent would: piped, so no color. */
function run(args: string[], cwd = APP) {
  const p = Bun.spawnSync(["bun", CLI, ...args], {
    cwd,
    env: { ...Bun.env, NO_COLOR: "1", FORCE_COLOR: undefined },
  });
  return {
    code: p.exitCode,
    out: p.stdout.toString(),
    err: p.stderr.toString(),
  };
}

test("parse: flags anywhere, values both ways, args after --", () => {
  const p = parse(["--native", "dev", "--port=3000", "--home", "x", "--", "a"]);
  expect(p.cmd).toBe("dev");
  expect([...p.flags]).toEqual(["--native"]);
  expect(p.values.get("--port")).toBe("3000");
  expect(p.values.get("--home")).toBe("x");
  expect(p.rest).toEqual(["a"]);
});

test.each([
  [["devv"], "unknown command devv (did you mean dev?)"],
  [["gen", "--chek"], "unknown option --chek for gen (did you mean --check?)"],
  [["build", "--jsno"], "unknown option --jsno for build"],
  [["test", "--home", "x"], "unknown option --home for test (dev takes it)"],
  [["--web", "dev"], "unknown option --web for dev"],
  [["build", "--web=1"], "--web is a switch"],
  [["dev", "--port"], "--port needs a value"],
  [["check", "foo"], "check takes no argument foo"],
  [["test", "x.e2e.ts"], "put it after --"],
])("parse rejects %j", (argv, msg) => {
  expect(() => parse(argv)).toThrow(msg);
});

test("a bad call exits 2 with one line, no usage", () => {
  const r = run(["gen", "--chek"]);
  expect(r.code).toBe(2);
  expect(r.err.trim().split("\n")).toHaveLength(1);
  expect(r.err).toStartWith("error: unknown option --chek");
});

test("no color in a pipe", () => {
  const r = run(["devv"]);
  expect(r.err).not.toContain("\x1b[");
});

test("--version prints the package version on stdout", async () => {
  // @reads package.json
  const pkg = await Bun.file(join(import.meta.dir, "../package.json")).json();
  const r = run(["--version"]);
  expect(r.code).toBe(0);
  expect(r.out.trim()).toBe(pkg.version);
});

test("--help goes to stdout and lists exit codes", () => {
  const r = run(["--help"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("Exit codes");
  expect(run(["gen", "--help"]).out).toContain("--check");
});

test("outside an app: exit 2 and say where to run it", () => {
  const r = run(["check"], empty);
  expect(r.code).toBe(2);
  expect(r.err).toContain("no app here");
});

test("a bad config exits 2", () => {
  writeFileSync(join(empty, "package.json"), "{}");
  const r = run(["check"], empty);
  expect(r.code).toBe(2);
  expect(r.err).toContain("no name");
});

test("a success says so", () => {
  const r = run(["gen", "--check"]);
  expect(r.code).toBe(0);
  expect(r.err).toContain("✓ gen");
});

test("--port must be a port", () => {
  const r = run(["dev", "--port", "abc"]);
  expect(r.code).toBe(2);
  expect(r.err).toContain("--port takes a number");
});

test("--json: one object on stdout, nothing on stderr", () => {
  const r = run(["gen", "--check", "--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out)).toEqual({ ok: true, stale: [] });
  expect(r.err).toBe("");
  expect(JSON.parse(run(["check", "--json"]).out)).toEqual({
    ok: true,
    problems: [],
  });
});

test("--json: a bad call is JSON too, and exits 2", () => {
  const r = run(["build", "--jsno", "--json"]);
  expect(r.code).toBe(2);
  expect(JSON.parse(r.out)).toMatchObject({
    ok: false,
    error: "unknown option --jsno for build (did you mean --json?)",
  });
  expect(r.err).toBe("");
});

test("--json: a build error lists Bun's messages with their place", () => {
  const dir = mkdtempSync(join(tmpdir(), "steambun-broken-"));
  try {
    symlinkSync(
      join(import.meta.dir, "../node_modules"),
      join(dir, "node_modules"),
    );
    writeFileSync(join(dir, "package.json"), '{"name":"Broke"}');
    writeFileSync(
      join(dir, "index.html"),
      '<script type="module" src="./m.ts"></script>',
    );
    writeFileSync(join(dir, "m.ts"), 'import "./nope.ts";\n');
    const r = run(["build", "--web", "--json"], dir);
    expect(r.code).toBe(1);
    const o = JSON.parse(r.out);
    expect(o.ok).toBe(false);
    expect(o.error).toBe("couldn't build the page: 1 error");
    expect(o.logs[0]).toStartWith("m.ts:1:8: Could not resolve");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--json only where a command has a result", () => {
  expect(() => parse(["dev", "--json"])).toThrow(
    "unknown option --json for dev (build, app, gen and check take it)",
  );
});
