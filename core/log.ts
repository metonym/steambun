// One line per event on stderr: time, scope, message.
// Quiet with STEAMBUN_QUIET=1, or `logger.quiet = true`.

export const logger = { quiet: process.env.STEAMBUN_QUIET === "1" };
const dim = (s: string) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

export function log(scope: string, msg: string) {
  if (logger.quiet) return;
  const t = new Date().toTimeString().slice(0, 8);
  console.error(`${dim(t)} ${scope.padEnd(6)} ${msg}`);
}

/** Milliseconds since `t0`, rounded, for log lines. */
export const since = (t0: number) => `${Math.round(performance.now() - t0)} ms`;
