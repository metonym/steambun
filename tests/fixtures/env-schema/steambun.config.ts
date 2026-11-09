// Fixture for tests/types/env.test-d.ts: a config whose envSchema types
// import.meta.env through the generated .steambun/env.d.ts next to it.
import { defineConfig } from "steambun";
import { z } from "zod";

export default defineConfig(() => ({
  envSchema: z.object({
    DATABASE_URL: z.url(),
    PUBLIC_FLAG: z.stringbool(),
  }),
}));
