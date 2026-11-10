import { expect, test } from "bun:test";
import { appSwift } from "../src/gen/bridge.ts";
import { defineBridge, op, t } from "../src/schema.ts";

const bridge = defineBridge({
  ops: {
    "ai.steps": op(
      t.struct("StepsArgs", { text: t.string }),
      t.list(t.string),
      {
        async: true,
      },
    ),
    "ai.ping": op(t.none, t.none, { async: true }),
    "ai.ready": op(t.none, t.bool),
  },
  events: {},
});

test("an async op gets an async throws method", () => {
  const s = appSwift(bridge, "bridge.ts");
  expect(s).toContain("func aiSteps(_ a: StepsArgs) async throws -> [String]");
  expect(s).toContain("func aiPing() async throws");
  expect(s).toContain("func aiReady() -> Bool");
});

// Bad args fail at the call, before any work starts.
test("an async op decodes its args before it runs", () => {
  const s = appSwift(bridge, "bridge.ts");
  expect(s).toContain(
    `case "ai.steps": let a = try bridgeDecode(StepsArgs.self, args); return BridgeAsync { return try await self.aiSteps(a) }`,
  );
  expect(s).toContain(
    `case "ai.ping": return BridgeAsync { try await self.aiPing(); return nil }`,
  );
});
