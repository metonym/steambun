/**
 * Vite-shaped `server.host` → Bun `hostname`. `false` stays loopback.
 *
 * @example
 * ```ts
 * hostnameFromHost(true);        // "0.0.0.0"
 * hostnameFromHost("example.lan"); // "example.lan"
 * hostnameFromHost(undefined);   // "127.0.0.1"
 * ```
 */
export function hostnameFromHost(
  host: string | boolean | undefined,
): string | undefined {
  if (host === true) return "0.0.0.0";
  if (typeof host === "string" && host.length > 0) return host;
  return "127.0.0.1";
}

/**
 * Mirrors Vite: the loopback bind address is shown/opened as `localhost` for
 * a friendlier URL, without changing what Bun actually bound.
 *
 * @example
 * ```ts
 * displayServerUrl(new URL("http://127.0.0.1:5173/")); // http://localhost:5173/
 * ```
 */
export function displayServerUrl(url: URL): URL {
  if (url.hostname !== "127.0.0.1") return url;
  const display = new URL(url);
  display.hostname = "localhost";
  return display;
}
