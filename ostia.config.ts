// Benchmarks: `bun run bench` (all), `bun run bench:quick` (no apps).
// Memory and sizes: `bun run bench:memory`. See CONTRIBUTING.md.
const cli = (example: string, ...args: string[]) => [
  "bun",
  "--cwd",
  `examples/${example}`,
  "../../src/cli.ts",
  ...args,
];
const src = ["src/**/*.ts"];

export default {
  workloads: [
    // What a user waits for at the terminal: a fresh process each time.
    {
      label: "cli: --help",
      command: ["bun", "src/cli.ts", "--help"],
      inputs: src,
    },
    {
      label: "cli: check (hello)",
      command: cli("hello", "check"),
      inputs: [...src, "examples/hello/**"],
    },
    {
      label: "cli: check (core)",
      command: cli("core", "check"),
      inputs: [...src, "examples/core/*.ts*"],
    },
    {
      label: "cli: gen --check (native-op)",
      command: cli("native-op", "gen", "--check"),
      inputs: [...src, "examples/native-op/native/**"],
    },
    // A built .app's cold launch to its page, then to its first paint.
    {
      label: "launch to load (hello)",
      command: ["bun", "bench/paint.ts", "hello"],
      timeSource: { pattern: "launch to load ([\\d.]+) ms" },
    },
    {
      label: "launch to paint (hello)",
      command: ["bun", "bench/paint.ts", "hello"],
      timeSource: { pattern: "launch to paint ([\\d.]+) ms" },
    },
    // WebKit's own first contentful paint: often before the page's rows.
    {
      label: "launch to WebKit paint (hello)",
      command: ["bun", "bench/paint.ts", "hello"],
      timeSource: { pattern: "launch to WebKit paint ([\\d.]+) ms" },
    },
    {
      label: "launch to load (core)",
      command: ["bun", "bench/paint.ts", "core"],
      timeSource: { pattern: "launch to load ([\\d.]+) ms" },
    },
    { label: "suites", suites: ["bench/*.bench.ts"] },
  ],
  bench: { suites: ["bench/*.bench.ts"] },
};
