// Type-level test compiled by `bun run typecheck` (`bun check`), not `bun test`.
import "../fixtures/env-schema/generated/env.d.ts";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const flag = import.meta.env.PUBLIC_FLAG;
const extra = import.meta.env.PUBLIC_EXTRA;

// From envSchema's output (z.stringbool()), not a plain string.
true satisfies Equals<typeof flag, boolean>;
// A public .env key the schema doesn't declare stays a string.
true satisfies Equals<typeof extra, string>;
