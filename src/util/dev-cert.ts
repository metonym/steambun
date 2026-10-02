import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { localNetworkAddresses, stripBrackets } from "./hostname";
import { STEAMBUN_DIR_NAME } from "./paths";
import { log } from "./terminal";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DevCertPaths {
  key: string;
  cert: string;
}

export function devCertPaths(root: string): DevCertPaths {
  const dir = join(root, STEAMBUN_DIR_NAME, "https");
  return { key: join(dir, "key.pem"), cert: join(dir, "cert.pem") };
}

/** Loopback names, `host` itself, and every LAN address when binding all interfaces (so the printed Network URLs are covered). */
export function devCertHosts(
  host: string | boolean | undefined,
  lanAddresses: () => string[] = localNetworkAddresses,
): string[] {
  const hosts = ["localhost", "127.0.0.1", "::1"];
  const name = typeof host === "string" ? stripBrackets(host.trim()) : "";
  if (host === true || name === "0.0.0.0" || name === "::") {
    hosts.push(...lanAddresses());
  } else if (name) {
    hosts.push(name);
  }
  return hosts;
}

function covers(cert: X509Certificate, host: string): boolean {
  return isIP(host)
    ? cert.checkIP(host) !== undefined
    : cert.checkHost(host) !== undefined;
}

/** Issues a certificate with mkcert (its local CA is what browsers trust), reusing the cached one while it's valid and covers `hosts`. */
export async function ensureDevCert(
  root: string,
  hosts: string[],
  mkcert: string | null = Bun.which("mkcert"),
): Promise<DevCertPaths & { created: boolean }> {
  const paths = devCertPaths(root);
  if (existsSync(paths.key) && existsSync(paths.cert)) {
    try {
      const cert = new X509Certificate(readFileSync(paths.cert));
      if (
        Date.parse(cert.validTo) - Date.now() > DAY_MS &&
        hosts.every((host) => covers(cert, host))
      ) {
        return { ...paths, created: false };
      }
    } catch {
      // Unreadable certificate: reissue.
    }
  }
  if (!mkcert) {
    throw new Error(
      "[steambun] server.https: true needs mkcert on PATH (https://github.com/FiloSottile/mkcert), or set server.https to { key, cert }.",
    );
  }
  await mkdir(join(paths.key, ".."), { recursive: true });
  // `--` keeps a host that starts with `-` from being read as a flag.
  const proc = Bun.spawnSync(
    [mkcert, "-key-file", paths.key, "-cert-file", paths.cert, "--", ...hosts],
    { stderr: "pipe", stdout: "pipe" },
  );
  if (proc.exitCode !== 0) {
    throw new Error(
      `[steambun] mkcert failed: ${proc.stderr.toString().trim()}`,
    );
  }
  return { ...paths, created: true };
}

export async function prepareDevCert(
  config: { root: string },
  host: string | boolean | undefined,
): Promise<void> {
  const { created } = await ensureDevCert(config.root, devCertHosts(host));
  if (created)
    log.info("[steambun] issued a local HTTPS certificate with mkcert");
}
