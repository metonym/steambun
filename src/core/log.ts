// One line per event on stderr: time, scope, message.
// Quiet with STEAMBUN_QUIET=1, or `logger.quiet = true`.

export const logger = { quiet: process.env.STEAMBUN_QUIET === "1" };
// Color as no-color.org says. Under the shell or `steambun dev`, stderr is
// a pipe; they set FORCE_COLOR when the terminal at the end takes it.
const { FORCE_COLOR, NO_COLOR } = process.env;
/** FORCE_COLOR wins, then NO_COLOR, then whether stderr is a terminal. */
function useColor() {
  if (FORCE_COLOR !== undefined) return FORCE_COLOR !== "0";
  if (NO_COLOR) return false;
  return !!process.stderr.isTTY;
}
const color = useColor();
const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);

export function log(scope: string, msg: string) {
  if (logger.quiet) return;
  const t = new Date().toTimeString().slice(0, 8);
  // Not console.error: Bun paints that red on a terminal.
  process.stderr.write(`${dim(t)} ${scope.padEnd(6)} ${msg}\n`);
}

/**
 * A line for whoever debugs steambun, not the app: timings, links,
 * frame counts. Only with STEAMBUN_VERBOSE=1 (`steambun dev --verbose`).
 */
export function detail(scope: string, msg: string) {
  if (process.env.STEAMBUN_VERBOSE === "1") log(scope, msg);
}
