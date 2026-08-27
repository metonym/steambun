#!/usr/bin/env bun
import { main } from "../src/cli";

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
