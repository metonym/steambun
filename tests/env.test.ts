import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBundleDefine,
  buildImportMetaEnvDefine,
  filterPublicEnv,
  loadEnvFiles,
  parseEnvFile,
  toPublicPath,
  withProcessEnv,
} from "../src/env/loader";
import { generateEnvDts, writeEnvDts } from "../src/env/types";

describe("parseEnvFile", () => {
  test("skips blank lines and # comments", () => {
    expect(
      parseEnvFile(`
# comment
FOO=bar

   # indented comment
BAZ=qux
`),
    ).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("parses KEY=value and quoted values", () => {
    expect(parseEnvFile(`PLAIN=one\nDOUBLE="two"\nSINGLE='three'`)).toEqual({
      PLAIN: "one",
      DOUBLE: "two",
      SINGLE: "three",
    });
  });

  test("supports backtick quotes", () => {
    expect(parseEnvFile('A=`it\'s "fine"`')).toEqual({ A: `it's "fine"` });
  });

  test("handles CR-LF and bare CR line endings", () => {
    expect(parseEnvFile("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
    expect(parseEnvFile("A=1\rB=2")).toEqual({ A: "1", B: "2" });
  });

  test("ignores lines without = or with an invalid key", () => {
    expect(parseEnvFile("NOPE\nOK=yes\nBAD KEY=1\n=2\n")).toEqual({
      OK: "yes",
    });
  });

  test("strips a leading BOM", () => {
    expect(parseEnvFile("\uFEFFA=1\nB=2")).toEqual({ A: "1", B: "2" });
  });

  test("accepts an export prefix", () => {
    expect(parseEnvFile("export A=1\nexport   B='two'\nexportC=3")).toEqual({
      A: "1",
      B: "two",
      exportC: "3",
    });
  });

  test("allows . and - in keys and whitespace around =", () => {
    expect(parseEnvFile("  a.b-c = 1  \nX =  y z ")).toEqual({
      "a.b-c": "1",
      X: "y z",
    });
  });

  test("trims unquoted values and keeps inner whitespace", () => {
    expect(parseEnvFile("A=   hello   world  \nB=\nC=   ")).toEqual({
      A: "hello   world",
      B: "",
      C: "",
    });
  });

  test("strips inline comments from unquoted values", () => {
    expect(
      parseEnvFile("A=value # note\nB=value#note\nC=# only comment"),
    ).toEqual({ A: "value", B: "value", C: "" });
  });

  test("keeps # and trims trailing comments around quoted values", () => {
    expect(parseEnvFile(`A="x # y" # note\nB='p#q'\nC=\`a # b\`  #c`)).toEqual({
      A: "x # y",
      B: "p#q",
      C: "a # b",
    });
  });

  test("preserves whitespace inside quotes", () => {
    expect(parseEnvFile(`A="  padded  "\nB='  x'`)).toEqual({
      A: "  padded  ",
      B: "  x",
    });
  });

  test("expands \\n and \\r in double quotes only", () => {
    expect(
      parseEnvFile(`A="line1\\nline2\\rend"\nB='a\\nb'\nC=\`a\\nb\``),
    ).toEqual({ A: "line1\nline2\rend", B: "a\\nb", C: "a\\nb" });
  });

  test("a backslash-escaped quote does not close the value", () => {
    expect(parseEnvFile(`A="say \\"hi\\""\nB='it\\'s'`)).toEqual({
      A: 'say \\"hi\\"',
      B: "it\\'s",
    });
  });

  test("keeps other quote kinds inside a quoted value", () => {
    expect(parseEnvFile(`A="it's"\nB='say "hi"'`)).toEqual({
      A: "it's",
      B: 'say "hi"',
    });
  });

  test("multi-line quoted values", () => {
    expect(
      parseEnvFile(`KEY="-----BEGIN-----
abc
-----END-----"
NEXT=1
S='one
two'
CRLF="a\r\nb"
`),
    ).toEqual({
      KEY: "-----BEGIN-----\nabc\n-----END-----",
      NEXT: "1",
      S: "one\ntwo",
      CRLF: "a\nb",
    });
  });

  test("an unterminated quote is read as an unquoted value to the end of the line", () => {
    expect(parseEnvFile(`A="oops\nB=2\nC='x # y`)).toEqual({
      A: '"oops',
      B: "2",
      C: "'x",
    });
  });

  test("text after a closing quote makes the value unquoted", () => {
    expect(parseEnvFile(`A="x" y\nB=2`)).toEqual({ A: '"x" y', B: "2" });
  });

  test("keeps = and quotes that are not leading", () => {
    expect(parseEnvFile('URL=postgres://u:p@h/db?a=b&c=d\nQ=a"b')).toEqual({
      URL: "postgres://u:p@h/db?a=b&c=d",
      Q: 'a"b',
    });
  });

  test("does no interpolation", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: dotenv-expand syntax, not an interpolation
    const src = "A=1\nB=$A ${A}";
    // biome-ignore lint/suspicious/noTemplateCurlyInString: dotenv-expand syntax, not an interpolation
    expect(parseEnvFile(src)).toEqual({ A: "1", B: "$A ${A}" });
  });

  test("later duplicates win", () => {
    expect(parseEnvFile("A=1\nA=2")).toEqual({ A: "2" });
  });

  test("a final line without a newline is parsed", () => {
    expect(parseEnvFile("A=1\nB=2")).toEqual({ A: "1", B: "2" });
  });

  test("empty input", () => {
    expect(parseEnvFile("")).toEqual({});
  });
});

describe("filterPublicEnv", () => {
  test("keeps only matching prefixes", () => {
    expect(
      filterPublicEnv({ VITE_A: "1", PUBLIC_B: "2", SECRET: "3", VITE: "4" }, [
        "VITE_",
        "PUBLIC_",
      ]),
    ).toEqual({ VITE_A: "1", PUBLIC_B: "2" });
  });
});

describe("buildImportMetaEnvDefine", () => {
  test("JSON-stringifies MODE/DEV/PROD/SSR/BASE_URL and public keys", () => {
    expect(
      buildImportMetaEnvDefine(
        { VITE_A: "1" },
        { mode: "development", command: "dev", base: "/" },
      ),
    ).toEqual({
      "import.meta.env.MODE": '"development"',
      "import.meta.env.DEV": "true",
      "import.meta.env.PROD": "false",
      "import.meta.env.SSR": "false",
      "import.meta.env.BASE_URL": '"/"',
      "import.meta.env.VITE_A": '"1"',
      "process.env.VITE_A": '"1"',
    });
  });
});

describe("buildBundleDefine", () => {
  const opts = {
    mode: "production",
    command: "build" as const,
    base: "/",
  };

  test("adds process.env.NODE_ENV from mode and keeps import.meta.env", () => {
    const define = buildBundleDefine({ VITE_A: "1" }, opts);
    expect(define["process.env.NODE_ENV"]).toBe('"production"');
    expect(define["import.meta.env.MODE"]).toBe('"production"');
    expect(define["import.meta.env.VITE_A"]).toBe('"1"');
    expect(define["process.env.VITE_A"]).toBe('"1"');
  });

  test("build is production whatever the mode, like Vite", () => {
    const define = buildBundleDefine({}, { ...opts, mode: "staging" });
    expect(define["process.env.NODE_ENV"]).toBe('"production"');
    expect(define["import.meta.env.PROD"]).toBe("true");
    expect(define["import.meta.env.MODE"]).toBe('"staging"');
  });

  test("dev is development, except --mode production where DEV, PROD, and NODE_ENV agree", () => {
    const dev = buildBundleDefine(
      {},
      { ...opts, command: "dev", mode: "test" },
    );
    expect(dev["process.env.NODE_ENV"]).toBe('"development"');
    expect(dev["import.meta.env.DEV"]).toBe("true");
    expect(dev["import.meta.env.PROD"]).toBe("false");
    const prod = buildBundleDefine({}, { ...opts, command: "dev" });
    expect(prod["process.env.NODE_ENV"]).toBe('"production"');
    expect(prod["import.meta.env.DEV"]).toBe("false");
    expect(prod["import.meta.env.PROD"]).toBe("true");
  });

  test("merges user define; user NODE_ENV wins", () => {
    const define = buildBundleDefine({}, opts, {
      "process.env.NODE_ENV": '"staging"',
      MY_FLAG: '"on"',
    });
    expect(define["process.env.NODE_ENV"]).toBe('"staging"');
    expect(define.MY_FLAG).toBe('"on"');
  });

  test("user import.meta.env keys override env-file defines", () => {
    const define = buildBundleDefine({ PUBLIC_TITLE: "from-env" }, opts, {
      "import.meta.env.PUBLIC_TITLE": JSON.stringify("from config"),
    });
    expect(define["import.meta.env.PUBLIC_TITLE"]).toBe('"from config"');
  });
});

describe("bare import.meta.env define", () => {
  const opts = { mode: "production", command: "build" as const, base: "/" };

  test("is an object literal of every import.meta.env.* define", () => {
    const define = buildBundleDefine({ VITE_A: "1" }, opts, undefined, {
      VITE_FLAG: true,
      VITE_LIST: [1, "x"],
    });
    expect(JSON.parse(define["import.meta.env"])).toEqual({
      MODE: "production",
      DEV: false,
      PROD: true,
      SSR: false,
      BASE_URL: "/",
      VITE_A: "1",
      VITE_FLAG: true,
      VITE_LIST: [1, "x"],
    });
  });

  test("reflects user import.meta.env.* defines", () => {
    const define = buildBundleDefine({ VITE_A: "1" }, opts, {
      "import.meta.env.VITE_A": '"override"',
    });
    expect(JSON.parse(define["import.meta.env"]).VITE_A).toBe("override");
  });

  test("a user-defined import.meta.env wins", () => {
    const define = buildBundleDefine({}, opts, { "import.meta.env": "{}" });
    expect(define["import.meta.env"]).toBe("{}");
  });

  test("is skipped when a user define is not JSON", () => {
    const define = buildBundleDefine({}, opts, {
      "import.meta.env.VITE_ID": "someGlobal",
    });
    expect("import.meta.env" in define).toBe(false);
  });

  test("Bun.build inlines it next to the per-key defines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-env-bare-"));
    writeFileSync(
      join(dir, "main.ts"),
      "console.log(JSON.stringify(import.meta.env), import.meta.env.VITE_A);\n",
    );
    const result = await Bun.build({
      entrypoints: [join(dir, "main.ts")],
      define: buildBundleDefine({ VITE_A: "1" }, opts, undefined, {
        VITE_N: 2,
      }),
    });
    expect(result.success).toBe(true);
    const out = await result.outputs[0].text();
    expect(out).toContain('VITE_A: "1"');
    expect(out).toContain("VITE_N: 2");
    expect(out).toContain('MODE: "production"');
  });
});

describe("env file precedence", () => {
  function envDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "steambun-env-"));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    return dir;
  }

  test(".env < .env.local < .env.[mode] < .env.[mode].local, and other modes are ignored", async () => {
    const dir = envDir({
      ".env": "A=env\nB=env\nC=env\nD=env\nE=env\n",
      ".env.local": "B=local\nC=local\nD=local\n",
      ".env.staging": "C=staging\nD=staging\n",
      ".env.staging.local": "D=staging-local\n",
      ".env.production": "E=production\nF=production\n",
    });
    expect(await loadEnvFiles("staging", dir)).toEqual({
      A: "env",
      B: "local",
      C: "staging",
      D: "staging-local",
      E: "env",
    });
  });

  test("withProcessEnv lets process.env win over every file, loadEnvFiles never reads it", async () => {
    const dir = envDir({
      ".env": "STEAMBUN_TEST_A=file\nSTEAMBUN_TEST_B=keep\n",
    });
    const prev = process.env.STEAMBUN_TEST_A;
    process.env.STEAMBUN_TEST_A = "shell";
    try {
      const files = await loadEnvFiles("development", dir);
      expect(files.STEAMBUN_TEST_A).toBe("file");
      const merged = withProcessEnv(files);
      expect(merged.STEAMBUN_TEST_A).toBe("shell");
      expect(merged.STEAMBUN_TEST_B).toBe("keep");
    } finally {
      if (prev === undefined) delete process.env.STEAMBUN_TEST_A;
      else process.env.STEAMBUN_TEST_A = prev;
    }
  });

  test("a missing envDir yields no values", async () => {
    expect(
      await loadEnvFiles("development", join(tmpdir(), "steambun-no-such-dir")),
    ).toEqual({});
  });
});

describe("generateEnvDts", () => {
  test("emits a client reference and no extra fields when there are no public keys", () => {
    expect(generateEnvDts([])).toBe(`// Auto-generated by steambun. Do not edit.
/// <reference types="steambun/client" />
`);
  });

  test("adds sorted extra keys and skips builtins", () => {
    expect(
      generateEnvDts(["PUBLIC_B", "MODE", "VITE_A"]),
    ).toBe(`// Auto-generated by steambun. Do not edit.
/// <reference types="steambun/client" />

export {};

declare global {
  interface ImportMetaEnv {
    readonly PUBLIC_B: string;
    readonly VITE_A: string;
  }
}
`);
  });

  test("quotes keys that are not identifiers", () => {
    expect(generateEnvDts(["PUBLIC-X"])).toContain(
      '  readonly "PUBLIC-X": string;',
    );
  });
});

describe("writeEnvDts", () => {
  test("writes .steambun/env.d.ts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-env-dts-"));
    const path = await writeEnvDts(dir, { PUBLIC_GREETING: "hello" });
    expect(path).toBe(join(dir, ".steambun", "env.d.ts"));
    expect(readFileSync(path, "utf8")).toContain(
      "readonly PUBLIC_GREETING: string;",
    );
  });

  test("does not rewrite the file when the content is unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steambun-env-dts-"));
    const path = await writeEnvDts(dir, { PUBLIC_GREETING: "hello" });
    const before = statSync(path).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeEnvDts(dir, { PUBLIC_GREETING: "hello" });
    expect(statSync(path).mtimeMs).toBe(before);
  });
});

describe("toPublicPath", () => {
  test("root base stays absolute", () => {
    expect(toPublicPath("/")).toBe("/");
  });

  test("adds a trailing slash when missing", () => {
    expect(toPublicPath("/app")).toBe("/app/");
    expect(toPublicPath("/app/")).toBe("/app/");
  });
});
