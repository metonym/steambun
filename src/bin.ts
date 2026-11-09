#!/usr/bin/env -S bun --no-env-file
import { main } from "./cli";

main(process.argv.slice(2)).catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  const unexpected = !message.startsWith("[steambun]");
  console.error(
    unexpected && process.env.STEAMBUN_DEBUG && err instanceof Error
      ? err.stack
      : message,
  );
  process.exitCode = 1;
});
