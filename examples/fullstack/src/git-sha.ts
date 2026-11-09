/** Bundle-time git SHA. Import with `{ type: "macro" }`. */
export function gitSha(): string {
  const result = Bun.spawnSync({
    cmd: ["git", "rev-parse", "--short", "HEAD"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return "unknown";
  return result.stdout.toString().trim();
}
