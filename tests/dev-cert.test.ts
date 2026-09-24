import { describe, expect, spyOn, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunfigToUserConfig } from "../src/config/bunfig";
import { tlsFromHttps } from "../src/runtime/http";
import {
  devCertPaths,
  ensureDevCert,
  generateSelfSignedCert,
} from "../src/util/dev-cert";

describe("generateSelfSignedCert", () => {
  test("covers every host, verifies against itself, and lasts 30 days", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const { cert } = await generateSelfSignedCert(
      ["localhost", "127.0.0.1", "::1", "192.168.1.20"],
      now,
    );
    const x509 = new X509Certificate(cert);
    expect(x509.subjectAltName).toBe(
      "DNS:localhost, IP Address:127.0.0.1, IP Address:0:0:0:0:0:0:0:1, IP Address:192.168.1.20",
    );
    expect(x509.verify(x509.publicKey)).toBe(true);
    expect(x509.checkHost("localhost")).toBe("localhost");
    expect(x509.checkIP("::1")).toBe("::1");
    expect(new Date(x509.validTo).getTime()).toBe(
      now.getTime() + 30 * 24 * 60 * 60 * 1000,
    );
  });

  test("serves TLS that a client trusting the certificate accepts", async () => {
    const { key, cert } = await generateSelfSignedCert([
      "localhost",
      "127.0.0.1",
    ]);
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: { key, cert },
      fetch: () => new Response("secure"),
    });
    const res = await fetch(`https://localhost:${server.port}/`, {
      tls: { ca: cert },
    });
    expect(await res.text()).toBe("secure");
  });
});

describe("ensureDevCert", () => {
  test("reuses the cached certificate until the hosts change", async () => {
    const root = mkdtempSync(join(tmpdir(), "steambun-cert-"));
    const first = await ensureDevCert(root, ["localhost", "127.0.0.1"], null);
    expect(first).toMatchObject({ issuer: "self-signed", created: true });
    const pem = readFileSync(first.cert, "utf8");

    const again = await ensureDevCert(root, ["127.0.0.1", "localhost"], null);
    expect(again.created).toBe(false);
    expect(readFileSync(again.cert, "utf8")).toBe(pem);

    const widened = await ensureDevCert(root, ["localhost", "10.0.0.5"], null);
    expect(widened.created).toBe(true);
    expect(new X509Certificate(readFileSync(widened.cert)).subjectAltName).toBe(
      "IP Address:10.0.0.5, DNS:localhost",
    );
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
