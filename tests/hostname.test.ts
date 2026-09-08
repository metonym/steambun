import { describe, expect, spyOn, test } from "bun:test";
import {
  displayServerUrl,
  displayServerUrls,
  hostnameFromHost,
  localNetworkAddresses,
} from "../src/util/hostname";
import { openBrowser, resolveOpenUrl } from "../src/util/open-browser";

describe("hostnameFromHost", () => {
  test("true binds all interfaces", () => {
    expect(hostnameFromHost(true)).toBe("0.0.0.0");
  });

  test("false and omitted stay on loopback", () => {
    expect(hostnameFromHost(false)).toBe("127.0.0.1");
    expect(hostnameFromHost(undefined)).toBe("127.0.0.1");
  });

  test("a string host is passed through", () => {
    expect(hostnameFromHost("192.168.1.4")).toBe("192.168.1.4");
  });
});

describe("displayServerUrl", () => {
  test("loopback is shown as localhost", () => {
    expect(displayServerUrl(new URL("http://127.0.0.1:5173/")).href).toBe(
      "http://localhost:5173/",
    );
  });

  test("non-loopback hosts are unchanged", () => {
    expect(displayServerUrl(new URL("http://0.0.0.0:5173/")).href).toBe(
      "http://0.0.0.0:5173/",
    );
    expect(displayServerUrl(new URL("http://192.168.1.4:5173/")).href).toBe(
      "http://192.168.1.4:5173/",
    );
  });
});

describe("resolveOpenUrl", () => {
  const url = new URL("http://127.0.0.1:5173/");

  test("true opens the server root", () => {
    expect(resolveOpenUrl(url, true)).toBe("http://127.0.0.1:5173/");
  });

  test("a path is resolved against the server url", () => {
    expect(resolveOpenUrl(url, "/about")).toBe("http://127.0.0.1:5173/about");
  });

  test("false and omitted do not open", () => {
    expect(resolveOpenUrl(url, false)).toBeNull();
    expect(resolveOpenUrl(url, undefined)).toBeNull();
  });
});

describe("localNetworkAddresses", () => {
  test("filters to non-internal IPv4 entries", () => {
    const fixture = {
      lo0: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4" as const,
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        },
        {
          address: "::1",
          netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
          family: "IPv6" as const,
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "::1/128",
          scopeid: 0,
        },
      ],
      en0: [
        {
          address: "192.168.1.4",
          netmask: "255.255.255.0",
          family: "IPv4" as const,
          mac: "aa:aa:aa:aa:aa:aa",
          internal: false,
          cidr: "192.168.1.4/24",
        },
        {
          address: "fe80::1",
          netmask: "ffff:ffff:ffff:ffff::",
          family: "IPv6" as const,
          mac: "aa:aa:aa:aa:aa:aa",
          internal: false,
          cidr: "fe80::1/64",
          scopeid: 4,
        },
      ],
    };
    expect(localNetworkAddresses(fixture)).toEqual(["192.168.1.4"]);
  });
});

describe("displayServerUrls", () => {
  test("a 0.0.0.0 bind splits into a localhost local URL and one network URL per address", () => {
    const url = new URL("http://0.0.0.0:5173/");
    const { local, network } = displayServerUrls(url, [
      "192.168.1.4",
      "10.0.0.5",
    ]);
    expect(local.href).toBe("http://localhost:5173/");
    expect(network.map((u) => u.href)).toEqual([
      "http://192.168.1.4:5173/",
      "http://10.0.0.5:5173/",
    ]);
  });

  test("a non-0.0.0.0 URL leaves network empty and local unchanged", () => {
    const url = new URL("http://192.168.1.4:5173/");
    const { local, network } = displayServerUrls(url);
    expect(network).toEqual([]);
    expect(local.href).toBe(displayServerUrl(url).href);
  });
});

describe("openBrowser", () => {
  test("swallows a throwing Bun.spawn and warns", () => {
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("Executable not found in $PATH");
    });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => openBrowser("http://localhost:5173")).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        "[steambun] could not open a browser: Executable not found in $PATH",
      );
    } finally {
      spawnSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
