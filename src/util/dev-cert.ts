import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { localNetworkAddresses } from "./hostname";
import { STEAMBUN_DIR_NAME } from "./paths";

// `server.https: true` → a certificate for dev and preview, cached under
// `.steambun/https/`. mkcert (when installed) issues one from its local CA,
// which browsers trust after `mkcert -install`; otherwise steambun signs a
// short-lived self-signed ECDSA certificate itself, DER-encoded by hand so
// there's no openssl or npm dependency. Browsers warn on self-signed
// certificates, same as Vite's basic-ssl plugin.

const VALIDITY_DAYS = 30;
const RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;

export interface DevCertPaths {
  key: string;
  cert: string;
}

/** Where `server.https: true` reads its key and certificate from. */
export function devCertPaths(root: string): DevCertPaths {
  const dir = join(root, STEAMBUN_DIR_NAME, "https");
  return { key: join(dir, "key.pem"), cert: join(dir, "cert.pem") };
}

interface Meta {
  hosts: string[];
  issuer: "mkcert" | "self-signed";
  notAfter: string;
}

/**
 * Reuses the cached certificate unless it's missing, expires within a day,
 * doesn't cover `hosts`, or mkcert has since become available.
 */
export async function ensureDevCert(
  root: string,
  hosts: string[],
  mkcert: string | null = Bun.which("mkcert"),
): Promise<DevCertPaths & { issuer: Meta["issuer"]; created: boolean }> {
  const paths = devCertPaths(root);
  const metaPath = join(root, STEAMBUN_DIR_NAME, "https", "meta.json");
  const wanted = [...new Set(hosts)].sort();
  const issuer = mkcert ? "mkcert" : "self-signed";

  if (existsSync(paths.key) && existsSync(paths.cert) && existsSync(metaPath)) {
    try {
      const meta = JSON.parse(await readFile(metaPath, "utf8")) as Meta;
      if (
        meta.issuer === issuer &&
        JSON.stringify(meta.hosts) === JSON.stringify(wanted) &&
        Date.parse(meta.notAfter) - Date.now() > RENEW_BEFORE_MS
      ) {
        return { ...paths, issuer, created: false };
      }
    } catch {
      // Unreadable meta: regenerate below.
    }
  }

  await mkdir(join(root, STEAMBUN_DIR_NAME, "https"), { recursive: true });
  let notAfter: Date;
  if (mkcert) {
    const proc = Bun.spawnSync(
      [mkcert, "-key-file", paths.key, "-cert-file", paths.cert, ...wanted],
      { stderr: "pipe", stdout: "pipe" },
    );
    if (proc.exitCode !== 0) {
      throw new Error(
        `[steambun] mkcert failed: ${proc.stderr.toString().trim()}`,
      );
    }
    // mkcert's leaf certificates are valid for 2 years and 3 months.
    notAfter = new Date(Date.now() + 820 * 24 * 60 * 60 * 1000);
  } else {
    const generated = await generateSelfSignedCert(wanted);
    await writeFile(paths.key, generated.key, { mode: 0o600 });
    await writeFile(paths.cert, generated.cert);
    notAfter = generated.notAfter;
  }
  const meta: Meta = {
    hosts: wanted,
    issuer,
    notAfter: notAfter.toISOString(),
  };
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  return { ...paths, issuer, created: true };
}

/**
 * `ensureDevCert` for a server bound to `host`: loopback names always, the
 * host itself when it's a name or address, and every LAN IPv4 address when
 * binding all interfaces (so the printed Network URLs match).
 */
export async function prepareDevCert(
  config: { root: string },
  host: string | boolean | undefined,
): Promise<void> {
  const hosts = ["localhost", "127.0.0.1", "::1"];
  if (host === true || host === "0.0.0.0") {
    hosts.push(...localNetworkAddresses());
  } else if (typeof host === "string" && host.length > 0) {
    hosts.push(host);
  }
  const result = await ensureDevCert(config.root, hosts);
  if (!result.created) return;
  console.log(
    result.issuer === "mkcert"
      ? "[steambun] issued a local HTTPS certificate with mkcert"
      : "[steambun] generated a self-signed HTTPS certificate (install mkcert for one browsers trust)",
  );
}

// --- Minimal DER encoding (X.690) for one self-signed X.509 v3 certificate.

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function der(tag: number, ...contents: Uint8Array[]): Uint8Array {
  const body = Buffer.concat(contents);
  return Buffer.concat([
    Uint8Array.from([tag, ...derLength(body.length)]),
    body,
  ]);
}

const sequence = (...items: Uint8Array[]) => der(0x30, ...items);
const set = (...items: Uint8Array[]) => der(0x31, ...items);
const explicit = (n: number, item: Uint8Array) => der(0xa0 + n, item);
const octetString = (bytes: Uint8Array) => der(0x04, bytes);
const utf8 = (text: string) => der(0x0c, Buffer.from(text, "utf8"));
const bitString = (bytes: Uint8Array) => der(0x03, Uint8Array.of(0), bytes);

/** A non-negative DER INTEGER from big-endian bytes. */
function integer(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const trimmed = bytes.subarray(start);
  const padded =
    trimmed[0]! & 0x80 ? Buffer.concat([Uint8Array.of(0), trimmed]) : trimmed;
  return der(0x02, padded);
}

function oid(dotted: string): Uint8Array {
  const [first, second, ...rest] = dotted.split(".").map(Number);
  const bytes = [first! * 40 + second!];
  for (const arc of rest) {
    const chunk: number[] = [];
    for (let n = arc; ; n = Math.floor(n / 128)) {
      chunk.unshift((n % 128) | (chunk.length ? 0x80 : 0));
      if (n < 128) break;
    }
    bytes.push(...chunk);
  }
  return der(0x06, Uint8Array.from(bytes));
}

function utcTime(date: Date): Uint8Array {
  const pad = (n: number) => String(n).padStart(2, "0");
  const text = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return der(0x17, Buffer.from(text, "ascii"));
}

function ipBytes(ip: string): Uint8Array {
  if (isIP(ip) === 4) return Uint8Array.from(ip.split(".").map(Number));
  // IPv6: expand "::" and write eight 16-bit groups.
  const [head = "", tail = ""] = ip.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const groups = ip.includes("::")
    ? [
        ...headGroups,
        ...Array(8 - headGroups.length - tailGroups.length).fill("0"),
        ...tailGroups,
      ]
    : headGroups;
  const out = new Uint8Array(16);
  groups.forEach((group, i) => {
    const value = Number.parseInt(group, 16);
    out[i * 2] = value >> 8;
    out[i * 2 + 1] = value & 0xff;
  });
  return out;
}

function extension(id: string, critical: boolean, value: Uint8Array) {
  return sequence(
    oid(id),
    ...(critical ? [der(0x01, Uint8Array.of(0xff))] : []),
    octetString(value),
  );
}

/** WebCrypto's ECDSA signature is raw r‖s; X.509 wants SEQUENCE { r, s }. */
function derSignature(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  return sequence(integer(raw.subarray(0, half)), integer(raw.subarray(half)));
}

function pem(label: string, bytes: Uint8Array): string {
  const base64 = Buffer.from(bytes).toString("base64");
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** A self-signed ECDSA P-256 certificate for `hosts` (DNS names and IPs). */
export async function generateSelfSignedCert(
  hosts: string[],
  now = new Date(),
): Promise<{ key: string; cert: string; notAfter: Date }> {
  const keys = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", keys.publicKey),
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", keys.privateKey),
  );

  const notBefore = new Date(now.getTime() - 60 * 1000);
  const notAfter = new Date(
    now.getTime() + VALIDITY_DAYS * 24 * 60 * 60 * 1000,
  );
  const name = sequence(set(sequence(oid("2.5.4.3"), utf8("steambun dev"))));
  const ecdsaWithSha256 = sequence(oid("1.2.840.10045.4.3.2"));
  const altNames = sequence(
    ...hosts.map((host) =>
      isIP(host)
        ? der(0x87, ipBytes(host))
        : der(0x82, Buffer.from(host, "ascii")),
    ),
  );
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0]! &= 0x7f;

  const tbs = sequence(
    explicit(0, integer(Uint8Array.of(2))), // v3
    integer(serial),
    ecdsaWithSha256,
    name,
    sequence(utcTime(notBefore), utcTime(notAfter)),
    name,
    spki,
    explicit(
      3,
      sequence(
        // basicConstraints CA:TRUE and keyUsage keyCertSign let the
        // certificate act as its own trust anchor — how a client (or a
        // keychain) that's told to trust it verifies it.
        extension("2.5.29.19", true, sequence(der(0x01, Uint8Array.of(0xff)))),
        // keyUsage: digitalSignature, keyCertSign
        extension("2.5.29.15", true, der(0x03, Uint8Array.of(2, 0x84))),
        // extKeyUsage: serverAuth
        extension("2.5.29.37", false, sequence(oid("1.3.6.1.5.5.7.3.1"))),
        extension("2.5.29.17", false, altNames), // subjectAltName
      ),
    ),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keys.privateKey,
      new Uint8Array(tbs),
    ),
  );
  const cert = sequence(
    tbs,
    ecdsaWithSha256,
    bitString(derSignature(signature)),
  );
  return {
    key: pem("PRIVATE KEY", pkcs8),
    cert: pem("CERTIFICATE", cert),
    notAfter,
  };
}
