// Cold launch of a built .app, as a user sees it: from spawning the shell
// to the page loaded (WebKit's didFinish), to its first paint and to
// WebKit's own first contentful paint. Only a page that imports
// `steambun/ui` reports a paint; for the rest, this prints the load alone.
// ostia reads the numbers with a timeSource: `bun bench/paint.ts hello`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigSync } from "../src/config.ts";
import { paths } from "../src/tools.ts";

const name = process.argv[2] ?? "hello";
const c = loadConfigSync(join(import.meta.dir, "../examples", name));
const home = mkdtempSync(join(tmpdir(), "steambun-paint-"));
const log = join(home, "native.log");
const WAIT_MS = 10_000;
// After the load, wait this long for a paint report before giving up on it.
const PAINT_GRACE_MS = 500;

const t0 = performance.now();
const proc = Bun.spawn(
  [paths(c).shell, "-STEAMBUN_HOME", home, "-STEAMBUN_LOG", log],
  {
    // Quiet, as in tests: no window to see, no Dock icon, no focus taken.
    // It still draws, so the timings hold.
    env: {
      ...Bun.env,
      STEAMBUN_STORE: join(home, "store"),
      STEAMBUN_QUIET: "1",
    },
    stdout: "ignore",
    stderr: "ignore",
  },
);

let loaded: number | null = null;
let painted: number | null = null;
// WebKit's own first contentful paint, from spawn.
let webkit: number | null = null;
while (painted === null && performance.now() - t0 < WAIT_MS) {
  if (loaded !== null && performance.now() - t0 - loaded > PAINT_GRACE_MS)
    break;
  await Bun.sleep(2);
  const f = Bun.file(log);
  if (!(await f.exists())) continue;
  const text = await f.text();
  if (loaded === null && text.includes("didFinish"))
    loaded = performance.now() - t0;
  const m = text.match(
    /first paint ([\d.]+) ms after navigation start(?: \(WebKit's first paint ([\d.]+) ms\))?/,
  );
  if (m) {
    painted = performance.now() - t0;
    // The line lands `ms` after navigation start; WebKit painted at `fcp`.
    if (m[2]) webkit = painted - Number(m[1]) + Number(m[2]);
  }
}
proc.kill();
await proc.exited;
rmSync(home, { recursive: true, force: true });

if (loaded === null) {
  console.error(`${name}: the page didn't load within ${WAIT_MS / 1000} s`);
  process.exit(1);
}
console.log(`launch to load ${loaded.toFixed(1)} ms`);
if (painted !== null) console.log(`launch to paint ${painted.toFixed(1)} ms`);
if (webkit !== null)
  console.log(`launch to WebKit paint ${webkit.toFixed(1)} ms`);
