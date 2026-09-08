import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Check, runDoctor } from "../src/doctor";

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "steambun-doctor-"));
  writeFileSync(
    join(root, "index.html"),
    `<!doctype html><html><body></body></html>\n`,
  );
  return root;
}

function cleanConfig(root: string): void {
  writeFileSync(join(root, "steambun.config.ts"), `export default {};\n`);
  writeFileSync(join(root, ".gitignore"), ".steambun\ndist\n");
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { types: ["@types/bun"] } }),
  );
}

function findAll(checks: Check[], id: string): Check[] {
  return checks.filter((check) => check.id === id);
}

const silentOptions = { json: true };

describe("runDoctor", () => {
  test("an all-clean project has no fail checks", async () => {
    const root = fixtureRoot();
    cleanConfig(root);

    const originalLog = console.log;
    console.log = () => {};
    let result: Awaited<ReturnType<typeof runDoctor>>;
    try {
      result = await runDoctor({ root, ...silentOptions });
    } finally {
      console.log = originalLog;
    }

    expect(result.ok).toBe(true);
    expect(result.checks.some((check) => check.level === "fail")).toBe(false);
  });

  test("no HTML entry fails html-entries", async () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-doctor-"));
    cleanConfig(root);

    const originalLog = console.log;
    console.log = () => {};
    let result: Awaited<ReturnType<typeof runDoctor>>;
    try {
      result = await runDoctor({ root, ...silentOptions });
    } finally {
      console.log = originalLog;
    }

    expect(findAll(result.checks, "html-entries")[0]?.level).toBe("fail");
    expect(result.ok).toBe(false);
  });

  test("a steambun.config.ts and a bunfig.toml [steambun] table warns config-conflict", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "steambun.config.ts"), `export default {};\n`);
    writeFileSync(join(root, "bunfig.toml"), `[steambun]\napi = "./src/api"\n`);

    const originalLog = console.log;
    console.log = () => {};
    let result: Awaited<ReturnType<typeof runDoctor>>;
    try {
      result = await runDoctor({ root, ...silentOptions });
    } finally {
      console.log = originalLog;
    }

    expect(findAll(result.checks, "config-conflict")[0]?.level).toBe("warn");
  });

  test("a steambun.config.ts and a vite.config.ts warns stray-vite-config", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "steambun.config.ts"), `export default {};\n`);
    writeFileSync(
      join(root, "vite.config.ts"),
      `export default { plugins: [] };\n`,
    );

    const originalLog = console.log;
    console.log = () => {};
    let result: Awaited<ReturnType<typeof runDoctor>>;
    try {
      result = await runDoctor({ root, ...silentOptions });
    } finally {
      console.log = originalLog;
    }

    expect(findAll(result.checks, "stray-vite-config")[0]?.level).toBe("warn");
  });

  test("tsconfig excluding .steambun fails tsconfig-reachability; no include/exclude is ok", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "steambun.config.ts"), `export default {};\n`);
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ exclude: [".steambun/**"] }),
    );

    const originalLog = console.log;
    console.log = () => {};
    let result: Awaited<ReturnType<typeof runDoctor>>;
    try {
      result = await runDoctor({ root, ...silentOptions });
    } finally {
      console.log = originalLog;
    }

    expect(findAll(result.checks, "tsconfig-reachability")[0]?.level).toBe(
      "fail",
    );

    const root2 = fixtureRoot();
    writeFileSync(join(root2, "steambun.config.ts"), `export default {};\n`);
    writeFileSync(join(root2, "tsconfig.json"), JSON.stringify({}));

    console.log = () => {};
    let result2: Awaited<ReturnType<typeof runDoctor>>;
    try {
      result2 = await runDoctor({ root: root2, ...silentOptions });
    } finally {
      console.log = originalLog;
    }

    expect(findAll(result2.checks, "tsconfig-reachability")[0]?.level).toBe(
      "ok",
    );
  });

  test("tsconfig missing bun types warns tsconfig-types", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "steambun.config.ts"), `export default {};\n`);
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { types: ["node"] } }),
    );

    const originalLog = console.log;
    console.log = () => {};
    let result: Awaited<ReturnType<typeof runDoctor>>;
    try {
      result = await runDoctor({ root, ...silentOptions });
    } finally {
      console.log = originalLog;
    }

    expect(findAll(result.checks, "tsconfig-types")[0]?.level).toBe("warn");
  });

  test("a secret-shaped public env key fails secret-env-keys", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "steambun.config.ts"), `export default {};\n`);
    writeFileSync(join(root, ".env"), "PUBLIC_STRIPE_SECRET_KEY=sk_live_x\n");

    const originalLog = console.log;
    console.log = () => {};
    let result: Awaited<ReturnType<typeof runDoctor>>;
    try {
      result = await runDoctor({ root, ...silentOptions });
    } finally {
      console.log = originalLog;
    }

    const check = findAll(result.checks, "secret-env-keys")[0];
    expect(check?.level).toBe("fail");
    expect(check?.message).toContain(
      "it will be inlined into client JavaScript",
    );
  });

  test("a .env.local file inside publicDir fails env-in-public-dir", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "steambun.config.ts"), `export default {};\n`);
    mkdirSync(join(root, "public"));
    writeFileSync(join(root, "public", ".env.local"), "FOO=1\n");

    const originalLog = console.log;
    console.log = () => {};
    let result: Awaited<ReturnType<typeof runDoctor>>;
    try {
      result = await runDoctor({ root, ...silentOptions });
    } finally {
      console.log = originalLog;
    }

    expect(findAll(result.checks, "env-in-public-dir")[0]?.level).toBe("fail");
  });

  test("build.outDir equal to root, and separately inside publicDir, both fail outdir-placement", async () => {
    const root = fixtureRoot();
    writeFileSync(
      join(root, "steambun.config.ts"),
      `export default { build: { outDir: "." } };\n`,
    );

    const originalLog = console.log;
    console.log = () => {};
    let result: Awaited<ReturnType<typeof runDoctor>>;
    try {
      result = await runDoctor({ root, ...silentOptions });
    } finally {
      console.log = originalLog;
    }

    expect(findAll(result.checks, "outdir-placement")[0]?.level).toBe("fail");

    const root2 = fixtureRoot();
    mkdirSync(join(root2, "public"));
    writeFileSync(
      join(root2, "steambun.config.ts"),
      `export default { build: { outDir: "public/dist" } };\n`,
    );

    console.log = () => {};
    let result2: Awaited<ReturnType<typeof runDoctor>>;
    try {
      result2 = await runDoctor({ root: root2, ...silentOptions });
    } finally {
      console.log = originalLog;
    }

    expect(findAll(result2.checks, "outdir-placement")[0]?.level).toBe("fail");
  });

  test("a config that throws on import returns one fail check and ok: false", async () => {
    const root = fixtureRoot();
    writeFileSync(
      join(root, "steambun.config.ts"),
      `throw new Error("boom");\n`,
    );

    const originalLog = console.log;
    console.log = () => {};
    let result: Awaited<ReturnType<typeof runDoctor>>;
    try {
      result = await runDoctor({ root, ...silentOptions });
    } finally {
      console.log = originalLog;
    }

    expect(result.ok).toBe(false);
    expect(result.checks.length).toBe(1);
    expect(result.checks[0]?.level).toBe("fail");
  });
});
