import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDefaults } from "../src/config/loader";
import { devChildEnv } from "../src/dev/dev";
import { generateServeSource } from "../src/dev/synth";

describe("devChildEnv", () => {
  test("forwards a numeric port", () => {
    expect(devChildEnv({ port: 5999 })).toEqual({ PORT: "5999" });
  });

  test("host: true binds all interfaces via an empty HOST", () => {
    expect(devChildEnv({ host: true })).toEqual({ HOST: "" });
  });

  test("a string host is passed through", () => {
    expect(devChildEnv({ host: "10.0.0.5" })).toEqual({ HOST: "10.0.0.5" });
  });

  test('strictPort: false is forwarded as "0"', () => {
    expect(devChildEnv({ strictPort: false })).toEqual({ STRICT_PORT: "0" });
  });

  test("no overrides produces no keys", () => {
    expect(devChildEnv({})).toEqual({});
  });
});

describe("generateServeSource", () => {
  test("reads port/host/strictPort from env before config", () => {
    const root = mktmp();
    const config = resolveDefaults(
      {},
      { root, command: "dev", mode: "development", configFile: null },
    );
    const source = generateServeSource(config, [], join(root, ".steambun"));
    expect(source).toContain("process.env.PORT");
    expect(source).toContain("process.env.HOST");
    expect(source).toContain("process.env.STRICT_PORT");
  });
});

function mktmp(): string {
  return mkdtempSync(join(tmpdir(), "steambun-dev-overrides-"));
}

async function getFreePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = server.port as number;
  server.stop(true);
  return port;
}

describe("steambun dev --port", () => {
  test("binds the spawned dev server to the requested port", async () => {
    const root = mktmp();
    writeFileSync(join(root, "index.html"), "<html></html>");
    const repoRoot = join(import.meta.dir, "..");
    mkdirSync(join(root, "node_modules"));
    symlinkSync(repoRoot, join(root, "node_modules", "steambun"));
    const port = await getFreePort();

    const binPath = join(repoRoot, "bin", "steambun.ts");
    const proc = Bun.spawn({
      cmd: ["bun", binPath, "dev", "--port", String(port)],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let output = "";
      const deadline = Date.now() + 10_000;
      while (!output.includes("dev server ready at")) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for dev server; got: ${output}`);
        }
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: false }>((resolve) =>
            setTimeout(() => resolve({ value: undefined, done: false }), 200),
          ),
        ]);
        if (done) break;
        if (value) output += decoder.decode(value);
      }
      expect(output).toContain(`:${port}/`);
    } finally {
      proc.kill();
    }
  }, 15_000);
});
