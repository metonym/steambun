import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDevTransformPlugin,
  generateEnvPluginSource,
} from "../src/dev/env-plugin";

type OnLoadResult = { contents: string; loader: string };
type OnLoadCallback = (args: { path: string }) => OnLoadResult;

async function loadTransform(
  defines: Record<string, string>,
): Promise<OnLoadCallback> {
  let cb: OnLoadCallback | undefined;
  createDevTransformPlugin(defines, { root: tmpdir() }).setup({
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

describe("dev transform plugin", () => {
  test("replaces a real usage", async () => {
    const cb = await loadTransform({
      "import.meta.env.API": '"https://api.example.com"',
    });
    const path = writeFixture("const base = import.meta.env.API;\n");
    const result = cb({ path });
    expect(result?.contents).toBe('const base = "https://api.example.com";\n');
  });

  test("does not replace inside a string literal", async () => {
    const cb = await loadTransform({
      "import.meta.env.API": '"https://api.example.com"',
    });
    const source = 'const msg = "import.meta.env.API is not a real call";\n';
    const path = writeFixture(source);
    const result = cb({ path });
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
    const result = cb({ path });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: expected output, not a real interpolation
    expect(result?.contents).toBe('const msg = `base: ${"X"}`;\n');
  });

  test("a nested block and a nested template inside an interpolation keep scanning correct", async () => {
    const cb = await loadTransform({ "import.meta.env.API": '"X"' });
    const path = writeFixture(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source, not a real interpolation
      "const a = `${(() => { return `${import.meta.env.API}`; })()} \"import.meta.env.API\" ${import.meta.env.API}`;\nconst s = 'it\\'s import.meta.env.API';\nconst b = import.meta.env.API;\n",
    );
    expect(cb({ path }).contents).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: expected output, not a real interpolation
      'const a = `${(() => { return `${"X"}`; })()} "import.meta.env.API" ${"X"}`;\nconst s = \'it\\\'s import.meta.env.API\';\nconst b = "X";\n',
    );
  });

  test("replaces a bare import.meta.env, while per-key defines still win over it", async () => {
    const cb = await loadTransform({
      "import.meta.env": '{"API":"X","MODE":"m"}',
      "import.meta.env.MODE": '"m"',
    });
    const path = writeFixture(
      "const all = import.meta.env;\nconst m = import.meta.env.MODE;\nconst u = import.meta.env.NOPE;\nconst l = import.meta.envX;\n",
    );
    expect(cb({ path }).contents).toBe(
      'const all = {"API":"X","MODE":"m"};\nconst m = "m";\nconst u = {"API":"X","MODE":"m"}.NOPE;\nconst l = import.meta.envX;\n',
    );
  });

  test("returns the source unchanged when the file has no defined key", async () => {
    const cb = await loadTransform({
      "import.meta.env.API": '"X"',
    });
    const path = writeFixture("const x = 1;\n");
    expect(cb({ path })).toEqual({ contents: "const x = 1;\n", loader: "ts" });
  });

  test("expands import.meta.glob alongside env keys", async () => {
    const cb = await loadTransform({ "import.meta.env.API": '"X"' });
    const path = writeFixture(
      'const m = import.meta.glob("./*.ts");\nconst a = import.meta.env.API;\n',
    );
    // The fixture's directory holds only itself, which a glob never includes.
    expect(cb({ path }).contents).toBe('const m = ({});\nconst a = "X";\n');
  });

  test("uses the jsx loader for .js so JSX in .js still parses", async () => {
    const cb = await loadTransform({});
    const dir = mkdtempSync(join(tmpdir(), "steambun-env-fixture-"));
    const path = join(dir, "view.js");
    writeFileSync(path, "export const v = <div />;\n");
    expect(cb({ path }).loader).toBe("jsx");
  });
});

describe("generateEnvPluginSource", () => {
  test("the generated file resolves steambun/internal and transforms a source file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-env-gen-"));
    mkdirSync(join(dir, "node_modules"));
    symlinkSync(
      join(import.meta.dir, ".."),
      join(dir, "node_modules", "steambun"),
    );
    const pluginPath = join(dir, "env-plugin.ts");
    writeFileSync(
      pluginPath,
      generateEnvPluginSource(
        { "import.meta.env.FOO": '"bar"', __APP_VERSION__: '"1"' },
        { root: dir },
      ),
    );
    let cb: OnLoadCallback | undefined;
    (await import(pluginPath)).default.setup({
      onLoad(_filter: unknown, fn: OnLoadCallback) {
        cb = fn;
      },
    });
    const path = join(dir, "main.ts");
    writeFileSync(
      path,
      "export const v = [import.meta.env.FOO, __APP_VERSION__];\n",
    );
    expect(cb?.({ path }).contents).toBe('export const v = ["bar", "1"];\n');
  });
});
