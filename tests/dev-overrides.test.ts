import { describe, expect, spyOn, test } from "bun:test";
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

// The decoder ships as source text in generated scripts, so evaluate it the same way.
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

  test("STRICT_PORT and OPEN accept 1/true and 0/false; empty or malformed values keep the default", () => {
    const decode = loadDecoder();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(decode({ OPEN: "true" }, defaults).open).toBe(true);
    expect(decode({ OPEN: "0" }, { ...defaults, open: true }).open).toBe(false);
    expect(
      decode({ STRICT_PORT: "false" }, { ...defaults, strictPort: true })
        .strictPort,
    ).toBe(false);
    expect(
      decode({ STRICT_PORT: "" }, { ...defaults, strictPort: true }).strictPort,
    ).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(decode({ OPEN: "yes" }, defaults).open).toBe(false);
    expect(decode({ STRICT_PORT: "maybe" }, defaults).strictPort).toBe(false);
    expect(warn.mock.calls.map((call) => call[0])).toEqual([
      '[steambun] ignoring invalid OPEN "yes"',
      '[steambun] ignoring invalid STRICT_PORT "maybe"',
    ]);
    warn.mockRestore();
  });

  test("a PORT outside 1-65535 is ignored in favor of the default", () => {
    expect(loadDecoder()({ PORT: "70000" }, defaults).port).toBe(5173);
    expect(loadDecoder()({ PORT: "0" }, defaults).port).toBe(5173);
    expect(loadDecoder()({ PORT: "65535" }, defaults).port).toBe(65535);
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

  test("open and strictPort encode as 1/0", () => {
    expect(childEnv({ open: true, strictPort: true })).toEqual({
      OPEN: "1",
      STRICT_PORT: "1",
    });
    expect(childEnv({ open: false })).toEqual({ OPEN: "0" });
  });

  test("no overrides produces no keys", () => {
    expect(childEnv({})).toEqual({});
  });
});
