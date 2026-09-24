import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { build } from "../src/build/build";
import { generateProdServeSource } from "../src/build/prod-server";
import { resolveDefaults } from "../src/config/loader";
import { buildImportMetaEnvDefine } from "../src/env/loader";
import {
  EnvValidationError,
  publicOutput,
  validateEnv,
} from "../src/env/schema";
import { generateEnvDts } from "../src/env/types";

const schema = z.object({
  DATABASE_URL: z.url(),
  PORT: z.coerce.number().default(3000),
  PUBLIC_FLAG: z.stringbool().default(false),
});

describe("validateEnv", () => {
  test("no schema is a no-op", async () => {
    expect(await validateEnv(undefined, { A: "1" })).toBeUndefined();
  });

  test("returns the schema's output, with defaults and transforms", async () => {
    expect(
      await validateEnv(schema, {
        DATABASE_URL: "postgres://db/app",
        PUBLIC_FLAG: "true",
        UNRELATED: "x",
      }),
    ).toEqual({
      DATABASE_URL: "postgres://db/app",
      PORT: 3000,
      PUBLIC_FLAG: true,
    });
  });

  test("lists every failing key without printing values", async () => {
    const error = await validateEnv(schema, {
      DATABASE_URL: "hunter2-not-a-url",
      PORT: "nope",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnvValidationError);
    const message = (error as Error).message;
    expect(message).toStartWith(
      "[steambun] Invalid environment (envSchema):\n  DATABASE_URL: ",
    );
    expect(message).toContain("\n  PORT: ");
    expect(message).not.toContain("hunter2");
  });

  test("rejects a value that isn't a Standard Schema", async () => {
    await expect(validateEnv({ parse() {} }, {})).rejects.toThrow(
      /must be a Standard Schema/,
    );
  });
});

describe("typed public env", () => {
  test("publicOutput keeps envPrefix keys with defined values", () => {
    expect(
      publicOutput({ PUBLIC_A: 1, PUBLIC_B: undefined, SECRET: "s" }, [
        "PUBLIC_",
      ]),
    ).toEqual({ PUBLIC_A: 1 });
  });

  test("schema output replaces import.meta.env values, not process.env", () => {
    const define = buildImportMetaEnvDefine(
      { PUBLIC_FLAG: "true" },
      { mode: "production", command: "build", base: "/" },
      { PUBLIC_FLAG: true, PUBLIC_DEFAULTED: 5 },
    );
    expect(define["import.meta.env.PUBLIC_FLAG"]).toBe("true");
    expect(define["process.env.PUBLIC_FLAG"]).toBe('"true"');
    expect(define["import.meta.env.PUBLIC_DEFAULTED"]).toBe("5");
  });

  test("generateEnvDts types schema keys from the config and the rest as strings", () => {
    const generated = generateEnvDts(["PUBLIC_FLAG", "PUBLIC_EXTRA"], false, {
      configSpecifier: "../steambun.config",
      prefixes: ["PUBLIC_"],
      schemaKeys: ["PUBLIC_FLAG"],
    });
    // The type test (tests/types/env.test-d.ts) compiles this same fixture.
    expect(generated).toBe(
      readFileSync(
        join(import.meta.dir, "fixtures/env-schema/generated/env.d.ts"),
        "utf8",
      ),
    );
  });
});

describe("envSchema in build and the prod server", () => {
  // A hand-rolled Standard Schema, since a temp project can't resolve zod.
  const CONFIG = `export default {
  build: { server: false },
  envSchema: {
    "~standard": {
      version: 1,
      vendor: "test",
      validate(env) {
        if (!env.DATABASE_URL) {
          return { issues: [{ message: "Required", path: ["DATABASE_URL"] }] };
        }
        return { value: { PUBLIC_FLAG: env.PUBLIC_FLAG === "true" } };
      },
    },
  },
};
`;

  function project(env: string): string {
    const root = mkdtempSync(join(tmpdir(), "steambun-env-schema-"));
    writeFileSync(
      join(root, "index.html"),
      '<!doctype html><html><body><script type="module" src="./main.ts"></script></body></html>',
    );
    writeFileSync(
      join(root, "main.ts"),
      "console.log(typeof import.meta.env.PUBLIC_FLAG);\n",
    );
    writeFileSync(join(root, "steambun.config.ts"), CONFIG);
    writeFileSync(join(root, ".env"), env);
    return root;
  }

  test("build inlines the schema's output", async () => {
    const root = project("DATABASE_URL=x\nPUBLIC_FLAG=true\n");
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await build({ root });
    } finally {
      log.mockRestore();
    }
    const js = [...new Bun.Glob("dist/assets/*.js").scanSync(root)]
      .map((file) => readFileSync(join(root, file), "utf8"))
      .join("");
    expect(js).toContain('"boolean"');
  });

  test("build fails on an invalid env", async () => {
    const root = project("PUBLIC_FLAG=true\n");
    await expect(build({ root })).rejects.toThrow("DATABASE_URL: Required");
  });

  test("the prod server checks process.env over build-time public values", () => {
    const config = resolveDefaults(
      { envSchema: schema },
      {
        root: "/app",
        command: "build",
        mode: "production",
        configFile: "/app/steambun.config.ts",
      },
    );
    const source = generateProdServeSource(config, "/app/dist", {
      envCheck: { PUBLIC_FLAG: "true" },
    });
    expect(source).toContain(
      'import { resolveDefaults, validateEnv } from "steambun";',
    );
    expect(source).toContain(
      'await validateEnv(config.envSchema, {\n    ...{"PUBLIC_FLAG":"true"},\n    ...process.env,\n  });',
    );
    expect(generateProdServeSource(config, "/app/dist")).not.toContain(
      "validateEnv",
    );
  });
});
