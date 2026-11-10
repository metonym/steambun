// How the CLI writes to the terminal. Status lines go to stderr, so
// stdout stays free for data: --json, --help, --version. Color only on a
// terminal: NO_COLOR turns it off, FORCE_COLOR turns it on
// (https://no-color.org).
import { homedir } from "node:os";
import { relative, resolve } from "node:path";

const env = process.env;
/** FORCE_COLOR wins, then NO_COLOR, then whether stderr is a terminal. */
function useColor() {
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0";
  if (env.NO_COLOR) return false;
  return !!process.stderr.isTTY;
}
export const color = useColor();

const paint = (code: string) => (s: string) =>
  color ? `\x1b[${code}m${s}\x1b[0m` : s;
export const bold = paint("1");
export const dim = paint("2");
const red = paint("31");
const green = paint("32");
const yellow = paint("33");

/** STEAMBUN_VERBOSE=1, or `--verbose`: every log line. */
export const verbose = () => env.STEAMBUN_VERBOSE === "1";

/**
 * `--json`: the CLI prints one JSON object on stdout when it ends, and no
 * lines on stderr. `steps` collects what `done` would have printed.
 */
export const json = { on: false, steps: [] as Step[] };

/** A finished step, as `--json` reports it. */
export interface Step {
  step: string;
  /** What it made, relative to where the CLI ran. */
  path?: string;
  bytes?: number;
  ms?: number;
  /** The rest of the line: "signed ad hoc", "reused: no Swift changed". */
  note?: string;
}

const line = (s: string) => json.on || process.stderr.write(`${s}\n`);
const LABEL = 6;
const pad = (label: string) => label.padEnd(LABEL);

/** A finished step: `✓ app    build/Hello.app · 972 KB · 1.2 s`. */
export function done(s: Step) {
  json.steps.push(s);
  const parts = [
    s.path,
    s.bytes === undefined ? undefined : size(s.bytes),
    s.note,
    s.ms === undefined ? undefined : time(s.ms),
  ].filter((p) => p !== undefined);
  line(`${green("✓")} ${bold(pad(s.step))} ${parts.join(dim(" · "))}`);
}

/** A fact about the run: `  page   http://127.0.0.1:3000/`. */
export const info = (label: string, ...detail: string[]) =>
  line(`  ${dim(pad(label))} ${detail.join(dim(" · "))}`);

/** A heading: the command and the app it runs on. */
export const head = (s: string) => line(bold(s));

/** Something to know that didn't stop the run. */
export const warn = (msg: string) => line(`${yellow("!")} ${msg}`);

/** The error the CLI exits with. */
export const error = (msg: string) =>
  line(`${red(bold("error:"))} ${msg.replace(/^steambun: /, "")}`);

/** A path as the caller would type it: relative to where they are. */
export function shown(p: string) {
  const rel = relative(process.cwd(), p) || ".";
  if (!rel.startsWith("..")) return rel;
  // Far away: ~/… or /… reads better than ../../../../var/….
  const home = homedir();
  const abs = resolve(p).startsWith(`${home}/`)
    ? `~${resolve(p).slice(home.length)}`
    : resolve(p);
  return abs.length < rel.length ? abs : rel;
}

/** Milliseconds since `t0`, whole. */
export const since = (t0: number) => Math.round(performance.now() - t0);

const time = (t: number) =>
  t < 1000 ? `${t} ms` : `${(t / 1000).toFixed(1)} s`;

export const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
