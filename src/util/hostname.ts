import { networkInterfaces } from "node:os";

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

/**
 * Non-internal IPv4 addresses from every interface. Best-effort: [] if the
 * call throws. `interfaces` is an injectable override (defaults to the real
 * `networkInterfaces()`) purely so tests don't have to monkey-patch a node:
 * builtin.
 */
export function localNetworkAddresses(
  interfaces?: NodeJS.Dict<import("node:os").NetworkInterfaceInfo[]>,
): string[] {
  try {
    const all = interfaces ?? networkInterfaces();
    const addresses: string[] = [];
    for (const infos of Object.values(all)) {
      for (const info of infos ?? []) {
        if (!info.internal && info.family === "IPv4") addresses.push(info.address);
      }
    }
    return addresses;
  } catch {
    return [];
  }
}

/**
 * When `url.hostname === "0.0.0.0"` (a `server.host: true` bind), `local` is
 * the `localhost`-renamed URL and `network` has one URL per non-internal
 * IPv4 address (from `addresses`, default `localNetworkAddresses()`).
 * Otherwise `network` is `[]` and `local` is `displayServerUrl(url)`
 * unchanged.
 */
export function displayServerUrls(
  url: URL,
  addresses?: string[],
): { local: URL; network: URL[] } {
  if (url.hostname !== "0.0.0.0") {
    return { local: displayServerUrl(url), network: [] };
  }
  const local = new URL(url);
  local.hostname = "localhost";
  const network = (addresses ?? localNetworkAddresses()).map((address) => {
    const networkUrl = new URL(url);
    networkUrl.hostname = address;
    return networkUrl;
  });
  return { local, network };
}
