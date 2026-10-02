import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Check, type DoctorOptions, runDoctor } from "../src/doctor";

function fixtureRoot(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "steambun-doctor-"));
  writeFileSync(
    join(root, "index.html"),
    `<!doctype html><html><body></body></html>\n`,
  );
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content);
  }
  return root;
}

const EMPTY_CONFIG = `export default {};\n`;

function cleanProject(): string {
  return fixtureRoot({
    "steambun.config.ts": EMPTY_CONFIG,
    ".gitignore": ".steambun\ndist\n",
    "tsconfig.json": JSON.stringify({
      compilerOptions: { types: ["@types/bun"] },
    }),
  });
}

async function doctor(root: string, opts: DoctorOptions = {}) {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    return await runDoctor({ root, json: true, ...opts });
  } finally {
    log.mockRestore();
  }
}

function findAll(checks: Check[], id: string): Check[] {
  return checks.filter((check) => check.id === id);
}

async function levelOf(root: string, id: string) {
  return findAll((await doctor(root)).checks, id)[0]?.level;
}

describe("runDoctor", () => {
  test("an all-clean project has no fail checks", async () => {
    const result = await doctor(cleanProject());
    expect(result.ok).toBe(true);
    expect(result.checks.some((check) => check.level === "fail")).toBe(false);
  });

  test("no HTML entry fails html-entries", async () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-doctor-"));
    writeFileSync(join(root, "steambun.config.ts"), EMPTY_CONFIG);
    const result = await doctor(root);
    expect(findAll(result.checks, "html-entries")[0]?.level).toBe("fail");
    expect(result.ok).toBe(false);
  });

  test("a steambun.config.ts and a bunfig.toml [steambun] table warns config-conflict", async () => {
    const root = fixtureRoot({
      "steambun.config.ts": EMPTY_CONFIG,
      "bunfig.toml": `[steambun]\napi = "./src/api"\n`,
    });
    expect(await levelOf(root, "config-conflict")).toBe("warn");
  });

  test("a steambun.config.ts and a vite.config.ts warns stray-vite-config", async () => {
    const root = fixtureRoot({
      "steambun.config.ts": EMPTY_CONFIG,
      "vite.config.ts": `export default { plugins: [] };\n`,
    });
    expect(await levelOf(root, "stray-vite-config")).toBe("warn");
  });

  test("a bunfig.toml and a vite.config.ts warns stray-vite-config", async () => {
    const root = fixtureRoot({
      "bunfig.toml": "[serve]\nport = 3000\n",
      "vite.config.ts": `export default { plugins: [] };\n`,
    });
    const check = findAll((await doctor(root)).checks, "stray-vite-config")[0];
    expect(check?.level).toBe("warn");
    expect(check?.message).toContain("bunfig.toml");
  });

  test("a vite.config.ts alone, or the explicit config, is not stray", async () => {
    const root = fixtureRoot({ "vite.config.ts": `export default {};\n` });
    expect(await levelOf(root, "stray-vite-config")).toBeUndefined();
    const withBunfig = fixtureRoot({
      "bunfig.toml": "",
      "vite.config.ts": `export default {};\n`,
    });
    const result = await doctor(withBunfig, { configFile: "vite.config.ts" });
    expect(findAll(result.checks, "stray-vite-config")).toEqual([]);
  });

  test("an absolute build.outDir is resolved, not joined onto root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "steambun-doctor-out-"));
    const root = fixtureRoot({
      "steambun.config.ts": `export default { build: { outDir: ${JSON.stringify(outside)} } };\n`,
      ".gitignore": ".steambun\n",
    });
    const result = await doctor(root);
    expect(findAll(result.checks, "gitignore")[0]?.level).toBe("ok");
  });

  describe("tsconfig-reachability", () => {
    const levelFor = (tsconfig: object) =>
      levelOf(
        fixtureRoot({
          "steambun.config.ts": EMPTY_CONFIG,
          "tsconfig.json": JSON.stringify(tsconfig),
        }),
        "tsconfig-reachability",
      );

    test("fails when exclude hides .steambun", async () => {
      expect(await levelFor({ exclude: [".steambun/**"] })).toBe("fail");
    });

    test("is ok without include/exclude", async () => {
      expect(await levelFor({})).toBe("ok");
    });

    test("fails when include omits .steambun", async () => {
      expect(await levelFor({ include: ["src"] })).toBe("fail");
    });

    test.each([
      ["."],
      ["./"],
      ["./**/*"],
      ["**/*"],
      [".steambun"],
      ["./.steambun/"],
    ])("is ok for include %p", async (pattern) => {
      expect(await levelFor({ include: [pattern] })).toBe("ok");
    });

    test("tolerates comments and trailing commas in tsconfig.json", async () => {
      const root = fixtureRoot({
        "steambun.config.ts": EMPTY_CONFIG,
        "tsconfig.json": `{ // note\n "exclude": [".steambun"], }\n`,
      });
      expect(await levelOf(root, "tsconfig-reachability")).toBe("fail");
    });

    test("warns when tsconfig.json cannot be parsed", async () => {
      const root = fixtureRoot({
        "steambun.config.ts": EMPTY_CONFIG,
        "tsconfig.json": `{ "include": [`,
      });
      expect(await levelOf(root, "tsconfig-reachability")).toBe("warn");
    });
  });

  test("a secret-shaped public env key fails secret-env-keys", async () => {
    const root = fixtureRoot({
      "steambun.config.ts": EMPTY_CONFIG,
      ".env": "PUBLIC_STRIPE_SECRET_KEY=sk_live_x\n",
    });
    const check = findAll((await doctor(root)).checks, "secret-env-keys")[0];
    expect(check?.level).toBe("fail");
    expect(check?.message).toContain(
      "it will be inlined into client JavaScript",
    );
  });

  test("--mode selects which .env.[mode] file is checked", async () => {
    const root = fixtureRoot({
      "steambun.config.ts": EMPTY_CONFIG,
      ".env.staging": "VITE_API_TOKEN=x\n",
    });
    expect(await levelOf(root, "secret-env-keys")).toBe("ok");
    const staging = await doctor(root, { mode: "staging" });
    expect(findAll(staging.checks, "secret-env-keys")[0]?.level).toBe("fail");
  });

  test("an invalid config (outDir at root) returns one config-load fail", async () => {
    const root = fixtureRoot({
      "steambun.config.ts": `export default { build: { outDir: "." } };\n`,
    });
    const result = await doctor(root);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.id).toBe("config-load");
  });

  test("a config that throws on import returns one fail check and ok: false", async () => {
    const root = fixtureRoot({
      "steambun.config.ts": `throw new Error("boom");\n`,
    });
    const result = await doctor(root);
    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({
      id: "config-load",
      level: "fail",
    });
  });
});
