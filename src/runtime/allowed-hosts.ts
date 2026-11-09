import { isIP } from "node:net";
import type { ServerOptions } from "../config/types";
import { errorResponse, isWebSocketUpgrade } from "./http";
import type { Middleware } from "./middleware";

// A bare hostname or bracketed IPv6 literal, with an optional port.
const HOST_HEADER = /^(\[[0-9a-f:.]+\]|[^\s:/?#@[\]]+)(?::\d*)?$/i;

/** Lowercased, without IPv6 brackets or an FQDN's trailing dot. */
function normalize(hostname: string): string {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname.replace(/\.$/, "");
  return bare.toLowerCase();
}

function hostOf(header: string): string | null {
  const match = HOST_HEADER.exec(header);
  return match ? normalize(match[1]!) : null;
}

function originHostOf(origin: string): string | null {
  try {
    return normalize(new URL(origin).hostname);
  } catch {
    return null;
  }
}

/** Loopback names and IP literals can't be DNS-rebinding targets, so they're always allowed. */
function isDefaultAllowed(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    isIP(hostname) !== 0
  );
}

function matcher(entries: string[]): (hostname: string) => boolean {
  const exact = new Set<string>();
  const suffixes: string[] = [];
  for (const entry of entries) {
    const name = normalize(entry);
    if (name.startsWith(".")) {
      exact.add(name.slice(1));
      suffixes.push(name);
    } else {
      exact.add(name);
    }
  }
  return (hostname) =>
    isDefaultAllowed(hostname) ||
    exact.has(hostname) ||
    suffixes.some((suffix) => hostname.endsWith(suffix));
}

/**
 * Rejects a request whose `Host` (or, for a WebSocket upgrade, `Origin`) isn't allowed, with a 403.
 * `undefined` when no check applies: `allowedHosts: true`, or `local` off with no explicit list.
 */
export function createHostGuard(
  server: ServerOptions,
  local: boolean,
): Middleware | undefined {
  const { allowedHosts, host } = server;
  if (allowedHosts === true || (!local && !allowedHosts)) return undefined;
  const entries = [...(allowedHosts ?? [])];
  if (local && typeof host === "string" && host) entries.push(host);
  const isAllowed = matcher(entries);
  const hint = "To allow it, add it to server.allowedHosts.";

  return (req, next) => {
    const header = req.headers.get("host");
    if (header !== null) {
      const hostname = hostOf(header);
      if (hostname === null || !isAllowed(hostname)) {
        return errorResponse(
          403,
          `Blocked request. Host "${header}" is not allowed. ${hint}`,
        );
      }
    }
    const origin = isWebSocketUpgrade(req) ? req.headers.get("origin") : null;
    if (origin !== null) {
      const hostname = originHostOf(origin);
      if (hostname === null || !isAllowed(hostname)) {
        return errorResponse(
          403,
          `Blocked request. Origin "${origin}" is not allowed. ${hint}`,
        );
      }
    }
    return next();
  };
}
