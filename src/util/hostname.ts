import { isIP } from "node:net";
import { type NetworkInterfaceInfo, networkInterfaces } from "node:os";

/** `[::1]` as written in URLs and some configs becomes `::1`. */
export function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** Vite-shaped `server.host` → Bun `hostname`; `false` and omitted stay on loopback. */
export function hostnameFromHost(host: string | boolean | undefined): string {
  if (host === true) return "0.0.0.0";
  if (typeof host === "string" && host.length > 0) return stripBrackets(host);
  return "127.0.0.1";
}

function withHostname(url: URL, hostname: string): URL {
  const copy = new URL(url);
  copy.hostname = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  return copy;
}

// URL serializes `::ffff:127.0.0.1` as `[::ffff:7f00:1]`.
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "[::1]", "[::ffff:7f00:1]"]);
const WILDCARD_HOSTNAMES = new Set(["0.0.0.0", "[::]"]);

/** Shows a loopback bind address (`127.0.0.1`, `::1`) as `localhost` (as Vite does) without changing what Bun bound. */
export function displayServerUrl(url: URL): URL {
  return LOOPBACK_HOSTNAMES.has(url.hostname)
    ? withHostname(url, "localhost")
    : url;
}

/** Non-internal IPv4 addresses; `interfaces` is injectable so tests needn't patch `node:os`. */
export function localNetworkAddresses(
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>,
): string[] {
  try {
    const addresses: string[] = [];
    for (const infos of Object.values(interfaces ?? networkInterfaces())) {
      for (const info of infos ?? []) {
        if (!info.internal && info.family === "IPv4") {
          addresses.push(info.address);
        }
      }
    }
    return addresses;
  } catch {
    // os.networkInterfaces() throws where the kernel denies the query (some sandboxes).
    return [];
  }
}

/** For a `0.0.0.0` or `::` bind: `localhost` plus one network URL per LAN address. Otherwise `local` only. */
export function displayServerUrls(
  url: URL,
  addresses?: string[],
): { local: URL; network: URL[] } {
  if (!WILDCARD_HOSTNAMES.has(url.hostname)) {
    return { local: displayServerUrl(url), network: [] };
  }
  return {
    local: withHostname(url, "localhost"),
    network: (addresses ?? localNetworkAddresses()).map((address) =>
      withHostname(url, address),
    ),
  };
}
