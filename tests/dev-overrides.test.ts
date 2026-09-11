import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDefaults } from "../src/config/loader";
import { generateServeSource } from "../src/dev/synth";
import { childEnv, SERVER_ENV_DECODER_SOURCE } from "../src/util/server-env";

type Overrides = {
  port: number;
  host: string | boolean | undefined;
  strictPort: boolean | undefined;
  open: boolean | string | undefined;
};
type Decoder = (
  env: Record<string, string | undefined>,
  defaults: Overrides,
) => Overrides;

// The decoder is emitted as source text into generated dev/preview scripts
// (see SERVER_ENV_DECODER_SOURCE's doc comment) rather than imported, so it's
// exercised here the same way: evaluated from its own source.
function loadDecoder(): Decoder {
  return new Function(`return ${SERVER_ENV_DECODER_SOURCE}`)() as Decoder;
}

describe("serverOverridesFromEnv (decoder half of childEnv)", () => {
  const defaults: Overrides = {
    port: 5173,
    host: false,
    strictPort: false,
    open: false,
  };

  test("falls back to defaults with no env vars set", () => {
    expect(loadDecoder()({}, defaults)).toEqual(defaults);
  });

  test('HOST="" (from childEnv({ host: true })) decodes back to true', () => {
    expect(loadDecoder()({ HOST: "" }, defaults).host).toBe(true);
  });

  test('STRICT_PORT="0" overrides a truthy default to false', () => {
    expect(
      loadDecoder()({ STRICT_PORT: "0" }, { ...defaults, strictPort: true })
        .strictPort,
    ).toBe(false);
  });

  test('STRICT_PORT="1" overrides a falsy default to true', () => {
    expect(loadDecoder()({ STRICT_PORT: "1" }, defaults).strictPort).toBe(true);
  });

  test("an invalid PORT is ignored in favor of the default", () => {
    expect(loadDecoder()({ PORT: "not-a-number" }, defaults).port).toBe(5173);
  });
});

describe("childEnv", () => {
  test("forwards a numeric port", () => {
    expect(childEnv({ port: 5999 })).toEqual({ PORT: "5999" });
  });

  test("host: true binds all interfaces via an empty HOST", () => {
    expect(childEnv({ host: true })).toEqual({ HOST: "" });
  });

  test("a string host is passed through", () => {
    expect(childEnv({ host: "10.0.0.5" })).toEqual({ HOST: "10.0.0.5" });
  });

  test('strictPort: false is forwarded as "0"', () => {
    expect(childEnv({ strictPort: false })).toEqual({ STRICT_PORT: "0" });
  });

  test("no overrides produces no keys", () => {
    expect(childEnv({})).toEqual({});
  });
});

describe("generateServeSource", () => {
  test("decodes port/host/strictPort/open from env before config via the shared decoder", () => {
    const root = mktmp();
    const config = resolveDefaults(
      {},
      { root, command: "dev", mode: "development", configFile: null },
    );
    const source = generateServeSource(config, [], join(root, ".steambun"));
    expect(source).toContain("function serverOverridesFromEnv(env, defaults)");
    expect(source).toContain("serverOverridesFromEnv(process.env, {");
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

    const binPath = join(repoRoot, "src", "bin.ts");
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
      while (!output.includes(`:${port}/`)) {
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
