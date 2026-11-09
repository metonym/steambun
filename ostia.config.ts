import { defineConfig } from "ostia";

// `bun run bench:ci` gates every bench task and the whole-pipeline build timings
// against `.ostia/baselines/main.json` (gitignored). Re-seed with
// `bun run bench:baseline` only when a new floor is intentionally accepted.
export default defineConfig({
  baseline: "main",
  thresholds: { timingPct: 5 },
  workloads: [
    { label: "suites", suites: ["bench/*.bench.ts"] },
    {
      label: "build:multi-page",
      command: ["bun", "src/bin.ts", "build", "--root", "examples/multi-page"],
      timeSource: { pattern: "built .* in (\\d+)ms" },
      inputs: ["src/**/*.ts", "examples/multi-page/**"],
    },
    {
      label: "build:fullstack",
      command: ["bun", "src/bin.ts", "build", "--root", "examples/fullstack"],
      timeSource: { pattern: "built .* in (\\d+)ms" },
      inputs: ["src/**/*.ts", "examples/fullstack/**"],
    },
  ],
});
