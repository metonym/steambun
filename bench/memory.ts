// Memory and size of each example as users run it: the built .app, its
// page loaded and idle. Memory is each process's footprint, the number
// Activity Monitor shows as "Memory", and its peak since launch. ostia
// measures its own process, not an app's, so this is a plain script:
// `bun run bench:memory`. It reports and never fails on a number.
//
// The page's WebKit processes run under launchd, not the shell, so they're
// the ones that appear during the launch. Close Safari and other WebKit
// apps first, or a tab they open in that window counts too.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { loadConfigSync } from "../src/config.ts";
import { launch } from "../src/test.ts";
import { app as buildApp, build, paths } from "../src/tools.ts";

const EXAMPLES = [
  ["hello", "h1"],
  ["core", "h1"],
  ["todo-bar", "body"],
  ["load-bar", "body"],
] as const;
// WebKit's GPU process spikes to ~200 MB for about a second at launch.
const SETTLE_MS = 5000;
const KINDS = ["shell", "core", "WebContent", "Networking", "GPU"];
const WEBKIT = "com.apple.WebKit.(WebContent|Networking|GPU)";

const lines = (s: string) => s.split("\n").filter(Boolean);
const pids = async (pattern: string) =>
  new Set(
    lines(await $`pgrep -f ${pattern}`.nothrow().quiet().text()).map(Number),
  );
const children = async (pid: number) =>
  lines(await $`pgrep -P ${pid}`.nothrow().quiet().text()).map(Number);
const comm = async (pid: number) =>
  (await $`ps -o comm= -p ${pid}`.nothrow().quiet().text()).trim();

const UNIT = { K: 1 / 1024, M: 1, G: 1024 } as const;
const toMB = (s = "") => {
  const m = s.match(/([\d.]+)([KMG])/);
  return m ? Number(m[1]) * UNIT[m[2] as keyof typeof UNIT] : Number.NaN;
};

/** Footprint now and at its peak, in MB. */
async function footprint(pid: number) {
  const out = await $`vmmap --summary ${pid}`.nothrow().quiet().text();
  return {
    now: toMB(out.match(/Physical footprint:\s+(\S+)/)?.[1]),
    peak: toMB(out.match(/Physical footprint \(peak\):\s+(\S+)/)?.[1]),
  };
}

const du = async (path: string) =>
  existsSync(path)
    ? Number((await $`du -sk ${path}`.quiet().text()).split("\t")[0]) / 1024
    : 0;

const memRows: string[][] = [];
const sizeRows: string[][] = [];
for (const [name, ready] of EXAMPLES) {
  const root = join(import.meta.dir, "../examples", name);
  // The .app as shipped: `steambun test` may have left a JIT core in it.
  const c = loadConfigSync(root);
  await build(c);
  await buildApp(c);
  const before = await pids(WEBKIT);
  const app = await launch({ root, backend: "native", built: true, ready });
  await Bun.sleep(SETTLE_MS);
  const parts: { kind: string; now: number; peak: number }[] = [];
  for (const pid of await children(process.pid)) {
    if (!(await comm(pid)).includes(".app/")) continue;
    parts.push({ kind: "shell", ...(await footprint(pid)) });
    for (const core of await children(pid))
      parts.push({ kind: "core", ...(await footprint(core)) });
  }
  for (const pid of await pids(WEBKIT)) {
    if (before.has(pid)) continue;
    const kind = (await comm(pid)).match(/com\.apple\.WebKit\.(\w+)$/)?.[1];
    if (kind) parts.push({ kind, ...(await footprint(pid)) });
  }
  await app.close();

  const sum = (k: "now" | "peak", kind?: string) =>
    parts.filter((p) => !kind || p.kind === kind).reduce((n, p) => n + p[k], 0);
  const cell = (kind?: string) =>
    kind && !parts.some((p) => p.kind === kind)
      ? "-"
      : `${sum("now", kind).toFixed(0)} (${sum("peak", kind).toFixed(0)})`;
  memRows.push([name, ...KINDS.map(cell), cell()]);

  const bundle = paths(c).app;
  const core = await du(join(bundle, "Contents/Helpers"));
  sizeRows.push([
    name,
    (await du(bundle)).toFixed(1),
    core ? core.toFixed(1) : "-",
    (await du(join(bundle, "Contents/Resources/page"))).toFixed(2),
  ]);
}

function table(head: string[], rows: string[][]) {
  const w = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]!.length)),
  );
  const line = (r: string[]) =>
    r.map((c, i) => (i ? c.padStart(w[i]!) : c.padEnd(w[i]!))).join("  ");
  console.log(line(head));
  for (const r of rows) console.log(line(r));
}

console.log(
  `Memory in MB, ${SETTLE_MS / 1000} s after the page was ready (peak since launch)`,
);
table(["app", ...KINDS, "total"], memRows);
console.log("\nSize on disk in MB");
table(["app", ".app", "core", "page"], sizeRows);
