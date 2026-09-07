import { describe, expect, test } from "bun:test";
import { mergeHeaderRules } from "../src/build/deploy";

describe("mergeHeaderRules", () => {
  test("a glob only in base passes through", () => {
    const merged = mergeHeaderRules({ "/a": { "X-A": "1" } }, {});
    expect(merged).toEqual({ "/a": { "X-A": "1" } });
  });

  test("a glob only in overrides passes through", () => {
    const merged = mergeHeaderRules({}, { "/b": { "X-B": "2" } });
    expect(merged).toEqual({ "/b": { "X-B": "2" } });
  });

  test("a glob in both merges, overrides winning on a colliding key and both surviving on a non-colliding key", () => {
    const merged = mergeHeaderRules(
      { "/c": { "X-Shared": "base", "X-Base-Only": "base" } },
      { "/c": { "X-Shared": "override", "X-Override-Only": "override" } },
    );
    expect(merged).toEqual({
      "/c": {
        "X-Shared": "override",
        "X-Base-Only": "base",
        "X-Override-Only": "override",
      },
    });
  });
});
