/**
 * Best-effort `open` / `xdg-open` / `cmd start`. Failures are ignored.
 *
 * @example
 * ```ts
 * openBrowser("http://localhost:5173");
 * ```
 */
export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    const proc = Bun.spawn({
      cmd,
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    proc.unref();
  } catch (err) {
    console.warn(
      `[steambun] could not open a browser: ${(err as Error).message}`,
    );
  }
}

/**
 * Vite-shaped `server.open` resolved against the dev server's own URL.
 *
 * @example
 * ```ts
 * resolveOpenUrl(new URL("http://localhost:5173"), "/about"); // ".../about"
 * resolveOpenUrl(new URL("http://localhost:5173"), true);     // the server URL itself
 * ```
 */
export function resolveOpenUrl(
  serverUrl: URL,
  open: boolean | string | undefined,
): string | null {
  if (!open) return null;
  if (open === true) return serverUrl.href;
  return new URL(open, serverUrl).href;
}
