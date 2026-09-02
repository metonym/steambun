import { describe, expect, test } from "bun:test";
import { displayServerUrl, hostnameFromHost } from "../src/util/hostname";
import { resolveOpenUrl } from "../src/util/open-browser";

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
