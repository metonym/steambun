import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import type { RouteRow } from "../src/runtime/app";

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "steambun-cli-"));
  writeFileSync(join(root, "index.html"), "<html></html>");
  return root;
}

async function quietMain(args: string[]): Promise<string[]> {
  const out: string[] = [];
  const log = spyOn(console, "log").mockImplementation((msg) => {
    out.push(String(msg));
  });
  try {
    await main(args);
  } finally {
    log.mockRestore();
  }
  return out;
}

describe("argument parsing", () => {
  test.each([
    [["bulid"], 'unknown command "bulid"'],
    [["constructor"], 'unknown command "constructor"'],
    [["--port", "3000", "bulid"], 'unknown command "bulid"'],
    [["build", "extra"], 'unexpected argument "extra" for `build`'],
    [["build", "--bogus"], "Unknown option '--bogus'"],
  ])("%p rejects with a [steambun]-prefixed error", async (args, message) => {
    await expect(main(args)).rejects.toThrow(`[steambun] ${message}`);
  });

  test.each([
    [
      ["dev", "--port", "abc"],
      '--port expects an integer from 1 to 65535, got "abc"',
    ],
    [["preview", "--port", "0"], "--port expects"],
    [["dev", "--port", "70000"], "--port expects"],
    [
      ["routes", "--logLevel", "loud"],
      "--logLevel expects one of silent, error, warn, info",
    ],
  ])("%p rejects an invalid flag value", async (args, message) => {
    await expect(main(args)).rejects.toThrow(message);
  });

  test("flags may precede the command", async () => {
    const root = project();
    const out = await quietMain(["--json", "--root", root, "routes"]);
    expect(Array.isArray(JSON.parse(out.join("\n")))).toBe(true);
  });

  test("--host accepts being the last argument (no value = bind every interface)", async () => {
    const root = project();
    // Parsing passes; preview then fails for the missing build, not for the flag.
    await expect(main(["preview", "--root", root, "--host"])).rejects.toThrow(
      "Run `steambun build` first",
    );
    await expect(
      main(["preview", "--root", root, "--host", "--mode", "x"]),
    ).rejects.toThrow("Run `steambun build` first");
  });
});

describe("flag applicability", () => {
  test.each([
    [["build", "--port", "3000"], "--port does not apply to `build`"],
    [["build", "--json"], "--json does not apply to `build`"],
    [["build", "--open"], "--open does not apply to `build`"],
    [["routes", "--host"], "--host does not apply to `routes`"],
    [["migrate", "--mode", "x"], "--mode does not apply to `migrate`"],
    [["migrate", "--config", "x"], "--config does not apply to `migrate`"],
    [["build", "--why", "x"], "--why does not apply to `build`"],
    [
      ["preview", "--compare", "a.json"],
      "--compare does not apply to `preview`",
    ],
    [["routes", "--html"], "--html does not apply to `routes`"],
    [["dev", "--brotli"], "--brotli does not apply to `dev`"],
    [["preview", "--no-emptyOutDir"], "--emptyOutDir does not apply"],
    [["migrate", "--strictPort"], "--strictPort does not apply to `migrate`"],
    [["build", "--ci"], "Unknown option '--ci'"],
    [["analyze", "--md"], "Unknown option '--md'"],
  ])("%p rejects", async (args, message) => {
    await expect(main(args)).rejects.toThrow(`[steambun] ${message}`);
  });

  test("global flags are accepted by every project command", async () => {
    const root = project();
    for (const command of ["routes", "doctor", "analyze"]) {
      const error = spyOn(console, "error").mockImplementation(() => {});
      try {
        await quietMain([
          command,
          "--root",
          root,
          "--mode",
          "development",
          "--logLevel",
          "silent",
        ]);
      } catch (err) {
        expect((err as Error).message).not.toContain("does not apply");
      } finally {
        error.mockRestore();
      }
    }
  });
});

describe("steambun build", () => {
  test("--no-emptyOutDir keeps files already in outDir", async () => {
    const root = project();
    writeFileSync(
      join(root, "steambun.config.ts"),
      "export default { build: { server: false } };\n",
    );
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "stale.txt"), "x");
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await main(["build", "--root", root, "--no-emptyOutDir"]);
    } finally {
      log.mockRestore();
    }
    expect(existsSync(join(root, "dist", "stale.txt"))).toBe(true);
  });
});

describe("steambun routes", () => {
  function write(root: string, files: Record<string, string>): string {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(root, name, ".."), { recursive: true });
      writeFileSync(join(root, name), content);
    }
    return root;
  }

  test("does not write .steambun/routes.d.ts", async () => {
    const root = project();
    await quietMain(["routes", "--root", root]);
    expect(existsSync(join(root, ".steambun", "routes.d.ts"))).toBe(false);
  });

  test("prints json rows for html, public, api, and proxy routes", async () => {
    const root = write(project(), {
      "public/favicon.ico": "icon",
      "api/health.ts":
        "export const GET = () => Response.json({ ok: true });\n",
      "steambun.config.ts": `export default {
  appType: "mpa",
  api: "./api",
  server: { proxy: { "/legacy": "http://localhost:9999" } },
};
`,
    });
    const rows = JSON.parse(
      (await quietMain(["routes", "--json", "--root", root])).join("\n"),
    ) as RouteRow[];
    const kinds = Object.fromEntries(rows.map((row) => [row.path, row.kind]));
    expect(kinds).toMatchObject({
      "/": "html",
      "/favicon.ico": "public",
      "/api/health": "api",
      "/legacy": "proxy",
      "/legacy/*": "proxy",
    });
  });

  test("reports each api route collision once, on stderr, keeping --json stdout parseable", async () => {
    const root = write(project(), {
      "api/index.ts": "export const GET = () => Response.json({ ok: true });\n",
      "api/[[...slug]].ts":
        "export const GET = () => Response.json({ catchAll: true });\n",
      "steambun.config.ts": `export default { appType: "mpa", api: "./api" };\n`,
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let out: string[];
    try {
      out = await quietMain(["routes", "--json", "--root", root]);
      expect(
        warn.mock.calls.filter(([line]) =>
          String(line).includes("api route collision"),
        ),
      ).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
    expect(Array.isArray(JSON.parse(out.join("\n")))).toBe(true);
  });
});

describe("steambun analyze", () => {
  function builtProject(): string {
    const root = project();
    mkdirSync(join(root, ".steambun"));
    writeFileSync(
      join(root, ".steambun", "metafile.json"),
      JSON.stringify({ inputs: {}, outputs: {} }),
    );
    return root;
  }

  test("--html with a path writes the treemap there", async () => {
    const root = builtProject();
    const out = join(root, "report.html");
    await quietMain(["analyze", "--root", root, "--html", out]);
    expect(existsSync(out)).toBe(true);
  });

  test("--html without a value writes <root>/analyze.html", async () => {
    const root = builtProject();
    await quietMain(["analyze", "--root", root, "--html"]);
    expect(existsSync(join(root, "analyze.html"))).toBe(true);
  });

  test.each([
    [["--json", "--html"], "--json cannot be combined with --html"],
    [["--json", "--why", "x"], "--json cannot be combined with --why"],
    [["--json", "--brotli"], "--json cannot be combined with --brotli"],
    [["--why", "x", "--html"], "--why cannot be combined with --html"],
    [["--why", "x", "--compare", "a.json"], "--why cannot be combined with"],
  ])("%p is rejected as incompatible", async (flags, message) => {
    await expect(
      main(["analyze", "--root", builtProject(), ...flags]),
    ).rejects.toThrow(`[steambun] ${message}`);
  });

  test("--json with --compare adds compare rows", async () => {
    const root = builtProject();
    const metafile = (bytes: number) => ({
      inputs: {},
      outputs: { "dist/a.js": { bytes, inputs: {}, imports: [], exports: [] } },
    });
    writeFileSync(
      join(root, ".steambun", "metafile.json"),
      JSON.stringify(metafile(20)),
    );
    const baseline = join(root, "baseline.json");
    writeFileSync(baseline, JSON.stringify(metafile(10)));
    const out = await quietMain([
      "analyze",
      "--root",
      root,
      "--json",
      "--compare",
      baseline,
    ]);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.compare).toEqual([
      expect.objectContaining({
        path: "dist/a.js",
        status: "changed",
        delta: 10,
      }),
    ]);
  });

  test("exits 1 when an output exceeds build.budgets", async () => {
    const root = builtProject();
    writeFileSync(
      join(root, "steambun.config.ts"),
      `export default { build: { budgets: { "**/*.js": 1 } } };\n`,
    );
    writeFileSync(
      join(root, ".steambun", "metafile.json"),
      JSON.stringify({
        inputs: {},
        outputs: {
          "dist/a.js": { bytes: 10, inputs: {}, imports: [], exports: [] },
        },
      }),
    );
    try {
      const out = await quietMain(["analyze", "--root", root]);
      expect(out.join("\n")).toContain("budget violations");
      expect(process.exitCode).toBe(1);
    } finally {
    }
  });

  test("without a metafile it fails with exit code 1", async () => {
    const root = project();
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await main(["analyze", "--root", root]);
      expect(process.exitCode).toBe(1);
      expect(String(error.mock.calls[0]?.[0])).toContain("steambun build");
    } finally {
      error.mockRestore();
    }
  });
});
