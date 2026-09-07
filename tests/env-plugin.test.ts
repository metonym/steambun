import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateEnvPluginSource } from "../src/dev/env-plugin";

type OnLoadArgs = { path: string };
type OnLoadResult = { contents: string; loader: string } | undefined;
type OnLoadCallback = (args: OnLoadArgs) => Promise<OnLoadResult>;

async function loadTransform(
  defines: Record<string, string>,
): Promise<OnLoadCallback> {
  const dir = mkdtempSync(join(tmpdir(), "steambun-env-plugin-"));
  const pluginPath = join(dir, "env-plugin.ts");
  writeFileSync(pluginPath, generateEnvPluginSource(defines));
  const plugin = (await import(pluginPath)).default;
  let cb: OnLoadCallback | undefined;
  plugin.setup({
    onLoad(_filter: unknown, fn: OnLoadCallback) {
      cb = fn;
    },
  } as import("bun").PluginBuilder);
  if (!cb) throw new Error("onLoad was not registered");
  return cb;
}

function writeFixture(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "steambun-env-fixture-"));
  const path = join(dir, "fixture.ts");
  writeFileSync(path, contents);
  return path;
}

describe("generated env plugin transform", () => {
  test("replaces a real usage", async () => {
    const cb = await loadTransform({
      "import.meta.env.API": '"https://api.example.com"',
    });
    const path = writeFixture("const base = import.meta.env.API;\n");
    const result = await cb({ path });
    expect(result?.contents).toBe('const base = "https://api.example.com";\n');
  });

  test("does not replace inside a string literal", async () => {
    const cb = await loadTransform({
      "import.meta.env.API": '"https://api.example.com"',
    });
    const source = 'const msg = "import.meta.env.API is not a real call";\n';
    const path = writeFixture(source);
    const result = await cb({ path });
    expect(result?.contents ?? source).toBe(source);
  });

  test("does not replace inside comments", async () => {
    const cb = await loadTransform({
      "import.meta.env.API": '"https://api.example.com"',
    });
    const lineSource = "// import.meta.env.API\nconst x = 1;\n";
    const linePath = writeFixture(lineSource);
    const lineResult = await cb({ path: linePath });
    expect(lineResult?.contents ?? lineSource).toBe(lineSource);

    const blockSource = "/* import.meta.env.API */\nconst x = 1;\n";
    const blockPath = writeFixture(blockSource);
    const blockResult = await cb({ path: blockPath });
    expect(blockResult?.contents ?? blockSource).toBe(blockSource);
  });

  test("a prefix key does not match inside a longer identifier", async () => {
    const cb = await loadTransform({
      "import.meta.env.FOO": '"bar"',
    });
    const untouchedSource = "const x = import.meta.env.FOOBAR;\n";
    const untouchedPath = writeFixture(untouchedSource);
    const untouchedResult = await cb({ path: untouchedPath });
    expect(untouchedResult?.contents ?? untouchedSource).toBe(untouchedSource);

    const touchedPath = writeFixture("const x = import.meta.env.FOO;\n");
    const result = await cb({ path: touchedPath });
    expect(result?.contents).toBe('const x = "bar";\n');
  });

  test("replaces inside a template-literal interpolation", async () => {
    const cb = await loadTransform({
      "import.meta.env.API": '"X"',
    });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source, not a real interpolation
    const path = writeFixture("const msg = `base: ${import.meta.env.API}`;\n");
    const result = await cb({ path });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: expected output, not a real interpolation
    expect(result?.contents).toBe('const msg = `base: ${"X"}`;\n');
  });

  test("returns undefined when the file has no defined key", async () => {
    const cb = await loadTransform({
      "import.meta.env.API": '"X"',
    });
    const path = writeFixture("const x = 1;\n");
    expect(await cb({ path })).toBeUndefined();
  });
});
