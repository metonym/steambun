import { log } from "./terminal";

/** The launcher command for `url`. Windows avoids `cmd /c start`, where `&` in the URL would start a second command. */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32")
    return ["rundll32", "url.dll,FileProtocolHandler", url];
  return ["xdg-open", url];
}

/** Best-effort `open` / `xdg-open` / `rundll32`; failures only warn. */
export function openBrowser(url: string): void {
  try {
    Bun.spawn({
      cmd: browserCommand(url),
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    }).unref();
  } catch (err) {
    log.warn(`[steambun] could not open a browser: ${(err as Error).message}`);
  }
}

/** Vite-shaped `server.open` resolved against the server's URL; `null` when disabled. */
export function resolveOpenUrl(
  serverUrl: URL,
  open: boolean | string | undefined,
): string | null {
  if (!open) return null;
  if (open === true) return serverUrl.href;
  return new URL(open, serverUrl).href;
}
