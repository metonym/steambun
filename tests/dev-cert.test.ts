import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunfigToUserConfig } from "../src/config/bunfig";
import { tlsFromHttps } from "../src/runtime/http";
import {
  devCertHosts,
  devCertPaths,
  ensureDevCert,
} from "../src/util/dev-cert";

const loopback = ["localhost", "127.0.0.1", "::1"];
const lan = () => ["192.168.1.4"];

describe("devCertHosts", () => {
  test("loopback names always, plus LAN addresses for true, 0.0.0.0 and ::", () => {
    expect(devCertHosts(undefined, lan)).toEqual(loopback);
    expect(devCertHosts(false, lan)).toEqual(loopback);
    for (const host of [true, "0.0.0.0", "::", "[::]"] as const) {
      expect(devCertHosts(host, lan)).toEqual([...loopback, "192.168.1.4"]);
    }
  });

  test("a specific host is added, brackets dropped", () => {
    expect(devCertHosts("[fe80::1]", lan)).toEqual([...loopback, "fe80::1"]);
    expect(devCertHosts("dev.example.com", lan)).toEqual([
      ...loopback,
      "dev.example.com",
    ]);
  });
});

describe("ensureDevCert", () => {
  test("fails without mkcert and names the alternative", async () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-cert-"));
    await expect(ensureDevCert(root, loopback, null)).rejects.toThrow(
      "needs mkcert on PATH",
    );
  });

  test("passes hosts after -- and reuses a cert that still covers them", async () => {
    const openssl = Bun.which("openssl");
    if (!openssl) return;
    const root = mkdtempSync(join(tmpdir(), "steambun-cert-"));
    // A stand-in mkcert that writes a real self-signed cert for the requested names.
    const fake = join(root, "fake-mkcert.sh");
    await Bun.write(
      fake,
      `#!/bin/sh
echo "$@" > "${root}/args"
key=$2; cert=$4; shift 5
san=""; for h in "$@"; do case "$h" in *:*|[0-9]*.[0-9]*.[0-9]*.[0-9]*) san="$san,IP:$h";; *) san="$san,DNS:$h";; esac; done
"${openssl}" req -x509 -newkey rsa:2048 -nodes -days 30 -subj /CN=t -addext "subjectAltName=\${san#,}" -keyout "$key" -out "$cert" 2>/dev/null
`,
    );
    Bun.spawnSync(["chmod", "+x", fake]);

    const first = await ensureDevCert(root, [...loopback, "-x"], fake);
    expect(first.created).toBe(true);
    expect(readFileSync(join(root, "args"), "utf8")).toContain(
      "-- localhost 127.0.0.1 ::1 -x",
    );
    const again = await ensureDevCert(root, loopback, null);
    expect(again.created).toBe(false);
    // A new host forces reissue, which needs mkcert.
    await expect(
      ensureDevCert(root, [...loopback, "10.0.0.5"], null),
    ).rejects.toThrow("mkcert");
  });
});

describe("server.https: true", () => {
  test("tlsFromHttps reads the dev certificate only when allowed", () => {
    const root = "/app";
    const tls = tlsFromHttps(true, root, { devCert: true });
    expect((tls?.cert as Bun.BunFile | undefined)?.name).toBe(
      devCertPaths(root).cert,
    );

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(tlsFromHttps(true, root)).toBeUndefined();
      expect(warn.mock.calls[0]?.[0]).toContain("serving plain HTTP");
    } finally {
      warn.mockRestore();
    }
  });

  test("bunfig accepts https = true", () => {
    const warnings: string[] = [];
    const config = bunfigToUserConfig(
      { steambun: { server: { https: true } } },
      (message) => warnings.push(message),
    );
    expect(config.server?.https).toBe(true);
    expect(warnings).toEqual([]);
  });
});
