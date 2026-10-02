import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunfigToUserConfig, parseBunfigToml } from "../src/config/bunfig";
import { resolveDefaults } from "../src/config/loader";
import type { ServerOptions } from "../src/config/types";
import { viteConfigToUserConfig } from "../src/config/vite";
import { createHostGuard } from "../src/runtime/allowed-hosts";
import { createApp } from "../src/runtime/app";

const servers: Bun.Server<unknown>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function guardStatus(
  server: ServerOptions,
  headers: Record<string, string>,
  local = true,
): number | "next" {
  const guard = createHostGuard(server, local);
  if (!guard) return "next";
  const res = guard(new Request("http://x/", { headers }), () => undefined);
  return res instanceof Response ? res.status : "next";
}

describe("createHostGuard", () => {
  test.each([
    "localhost",
    "localhost:5173",
    "app.localhost:3000",
    "LOCALHOST",
    "localhost.",
    "127.0.0.1",
    "127.0.0.1:8080",
    "[::1]",
    "[::1]:5173",
    "192.168.1.20:5173",
    "[2001:db8::1]:5173",
  ])("allows %s by default", (host) => {
    expect(guardStatus({}, { host })).toBe("next");
  });

  test.each([
    "evil.com",
    "evil.com:5173",
    "localhost.evil.com",
    "notlocalhost",
    "127.0.0.1.evil.com",
    "localhost@evil.com",
    "evil.com/localhost",
    "",
  ])("blocks %p by default", (host) => {
    expect(guardStatus({}, { host })).toBe(403);
  });

  test("a request without a Host header passes", () => {
    expect(guardStatus({}, {})).toBe("next");
  });

  test("the 403 body names the host and the option", async () => {
    const guard = createHostGuard({}, true)!;
    const res = guard(
      new Request("http://x/", { headers: { host: "evil.com:80" } }),
      () => undefined,
    ) as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error:
        'Blocked request. Host "evil.com:80" is not allowed. To allow it, add it to server.allowedHosts.',
    });
  });

  test("exact and leading-dot entries", () => {
    const server = { allowedHosts: ["app.example.com", ".corp.dev"] };
    expect(guardStatus(server, { host: "app.example.com:80" })).toBe("next");
    expect(guardStatus(server, { host: "example.com" })).toBe(403);
    expect(guardStatus(server, { host: "x.app.example.com" })).toBe(403);
    expect(guardStatus(server, { host: "corp.dev" })).toBe("next");
    expect(guardStatus(server, { host: "a.b.corp.dev" })).toBe("next");
    expect(guardStatus(server, { host: "evilcorp.dev" })).toBe(403);
    expect(guardStatus(server, { host: "corp.dev.evil.com" })).toBe(403);
  });

  test("a specific server.host string is allowed, a boolean adds nothing", () => {
    expect(guardStatus({ host: "dev.box" }, { host: "dev.box:5173" })).toBe(
      "next",
    );
    expect(guardStatus({ host: true }, { host: "dev.box" })).toBe(403);
  });

  test("true disables the check", () => {
    expect(guardStatus({ allowedHosts: true }, { host: "evil.com" })).toBe(
      "next",
    );
  });

  test("a deployed server checks only with an explicit list, which still allows IP literals", () => {
    expect(guardStatus({}, { host: "evil.com" }, false)).toBe("next");
    expect(guardStatus({ host: "dev.box" }, { host: "x.com" }, false)).toBe(
      "next",
    );
    const server = { allowedHosts: ["app.example.com"] };
    expect(guardStatus(server, { host: "evil.com" }, false)).toBe(403);
    expect(guardStatus(server, { host: "app.example.com" }, false)).toBe(
      "next",
    );
    expect(guardStatus(server, { host: "10.0.0.5:3000" }, false)).toBe("next");
  });

  test("Origin is checked only on WebSocket upgrades", () => {
    const upgrade = { host: "localhost", upgrade: "websocket" };
    expect(guardStatus({}, { ...upgrade, origin: "https://evil.com" })).toBe(
      403,
    );
    expect(guardStatus({}, { ...upgrade, origin: "null" })).toBe(403);
    expect(
      guardStatus({}, { ...upgrade, origin: "http://localhost:5173" }),
    ).toBe("next");
    expect(guardStatus({}, { ...upgrade, origin: "http://[::1]:5173" })).toBe(
      "next",
    );
    expect(guardStatus({}, upgrade)).toBe("next");
    expect(
      guardStatus({}, { host: "localhost", origin: "https://evil.com" }),
    ).toBe("next");
    expect(
      guardStatus(
        { allowedHosts: [".example.com"] },
        { ...upgrade, origin: "https://app.example.com" },
      ),
    ).toBe("next");
  });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "steambun-hosts-"));
  const apiDir = join(root, "api");
  mkdirSync(apiDir);
  writeFileSync(
    join(apiDir, "health.ts"),
    "export const GET = () => Response.json({ ok: true });\n",
  );
  writeFileSync(
    join(apiDir, "live.ts"),
    "export const websocket = { message(ws, m) { ws.send(m); } };\n",
  );
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "index.html"), "<html>built</html>");
  return root;
}

function config(root: string, server: ServerOptions = {}) {
  return resolveDefaults(
    { api: "api", publicDir: false, server },
    { root, command: "dev", mode: "development", configFile: null },
  );
}

async function serve(
  options: Parameters<typeof createApp>[0],
): Promise<Bun.Server<unknown>> {
  const app = await createApp(options);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    ...app.serveOptions,
  } as Bun.Serve.Options<unknown>);
  servers.push(server);
  return server;
}

const get = (server: Bun.Server<unknown>, path: string, host: string) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { host } });

describe("Host check on a running server", () => {
  test("dev blocks API and proxy routes for a foreign Host and allows local ones", async () => {
    const root = project();
    const upstream = Bun.serve({
      port: 0,
      fetch: () => new Response("upstream"),
    });
    servers.push(upstream);
    const server = await serve({
      mode: "dev",
      config: config(root, {
        proxy: { "/up": `http://127.0.0.1:${upstream.port}` },
      }),
    });

    for (const path of ["/api/health", "/up/x", "/api/nope"]) {
      const res = await get(server, path, "evil.com");
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain(
        'Host "evil.com" is not allowed',
      );
    }
    for (const host of [
      "localhost:5173",
      "127.0.0.1:5173",
      "[::1]:5173",
      "10.1.2.3",
    ]) {
      expect((await get(server, "/api/health", host)).status).toBe(200);
      expect(await (await get(server, "/up/x", host)).text()).toBe("upstream");
    }
  });

  test("allowedHosts adds hosts, and true disables the check", async () => {
    const root = project();
    const listed = await serve({
      mode: "dev",
      config: config(root, { allowedHosts: [".example.com"] }),
    });
    expect((await get(listed, "/api/health", "a.example.com")).status).toBe(
      200,
    );
    expect((await get(listed, "/api/health", "evil.com")).status).toBe(403);

    const open = await serve({
      mode: "dev",
      config: config(root, { allowedHosts: true }),
    });
    expect((await get(open, "/api/health", "evil.com")).status).toBe(200);
  });

  test("preview guards static files and the SPA fallback", async () => {
    const root = project();
    const server = await serve({
      mode: "preview",
      outDir: join(root, "dist"),
      config: config(root),
    });
    expect((await get(server, "/", "evil.com")).status).toBe(403);
    expect((await get(server, "/deep/link", "evil.com")).status).toBe(403);
    expect((await get(server, "/api/health", "evil.com")).status).toBe(403);
    const ok = await get(server, "/", "localhost:4173");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("<html>built</html>");
  });

  test("deployed preview (dist/server.js, binaries) checks only an explicit allowedHosts", async () => {
    const root = project();
    const outDir = join(root, "dist");
    const unchecked = await serve({
      mode: "preview",
      deployed: true,
      outDir,
      config: config(root),
    });
    expect((await get(unchecked, "/", "app.example.com")).status).toBe(200);

    const checked = await serve({
      mode: "preview",
      deployed: true,
      outDir,
      config: config(root, { allowedHosts: ["app.example.com"] }),
    });
    expect((await get(checked, "/", "app.example.com")).status).toBe(200);
    expect((await get(checked, "/", "evil.com")).status).toBe(403);
    expect((await get(checked, "/api/health", "evil.com")).status).toBe(403);
  });
});

describe("WebSocket Origin check", () => {
  function open(url: string, origin?: string): Promise<"open" | "rejected"> {
    return new Promise((resolve) => {
      const ws = new WebSocket(
        url,
        origin ? ({ headers: { origin } } as never) : undefined,
      );
      ws.onopen = () => {
        ws.close();
        resolve("open");
      };
      ws.onerror = () => resolve("rejected");
    });
  }

  test("API ws routes reject a foreign Origin and accept allowed or absent ones", async () => {
    const root = project();
    const server = await serve({ mode: "dev", config: config(root) });
    const url = `ws://127.0.0.1:${server.port}/api/live`;

    expect(await open(url, "https://evil.com")).toBe("rejected");
    expect(await open(url, "http://localhost:5173")).toBe("open");
    expect(await open(url, "http://127.0.0.1:5173")).toBe("open");
    expect(await open(url)).toBe("open");
  });

  test("proxied ws entries reject a foreign Origin", async () => {
    const root = project();
    const upstream = Bun.serve({
      port: 0,
      fetch: (req, srv) =>
        srv.upgrade(req) ? undefined : new Response("no", { status: 400 }),
      websocket: { message() {} },
    });
    servers.push(upstream);
    const server = await serve({
      mode: "dev",
      config: config(root, {
        proxy: {
          "/socket": { target: `http://127.0.0.1:${upstream.port}`, ws: true },
        },
      }),
    });
    const url = `ws://127.0.0.1:${server.port}/socket`;

    expect(await open(url, "https://evil.com")).toBe("rejected");
    expect(await open(url, "http://localhost:5173")).toBe("open");
  });

  test("an Origin added to allowedHosts is accepted", async () => {
    const root = project();
    const server = await serve({
      mode: "dev",
      config: config(root, { allowedHosts: [".example.com"] }),
    });
    const url = `ws://127.0.0.1:${server.port}/api/live`;
    expect(await open(url, "https://app.example.com")).toBe("open");
  });
});

describe("server.allowedHosts config", () => {
  const resolve = (allowedHosts: unknown) =>
    resolveDefaults(
      { server: { allowedHosts: allowedHosts as never } },
      { root: "/tmp", command: "dev", mode: "development", configFile: null },
    );

  test("accepts true and a string array", () => {
    expect(resolve(true).server.allowedHosts).toBe(true);
    expect(resolve([".example.com"]).server.allowedHosts).toEqual([
      ".example.com",
    ]);
  });

  test.each([false, "example.com", [1], [""], {}])("rejects %p", (value) => {
    expect(() => resolve(value)).toThrow("[steambun] server.allowedHosts");
  });

  test("decodes from bunfig.toml", () => {
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    expect(
      bunfigToUserConfig(
        parseBunfigToml(
          '[steambun.server]\nallowedHosts = ["a.com", ".b.com"]\n',
        ),
        warn,
      ).server,
    ).toEqual({ allowedHosts: ["a.com", ".b.com"] });
    expect(
      bunfigToUserConfig(
        parseBunfigToml("[steambun.server]\nallowedHosts = true\n"),
        warn,
      ).server,
    ).toEqual({ allowedHosts: true });
    expect(warnings).toEqual([]);

    bunfigToUserConfig(
      parseBunfigToml('[steambun.server]\nallowedHosts = "all"\n'),
      warn,
    );
    expect(warnings[0]).toContain("server.allowedHosts");
  });

  test("converts from a Vite config", () => {
    const convert = (allowedHosts: unknown) =>
      viteConfigToUserConfig({ server: { allowedHosts } }, () => {}).server;
    expect(convert(["a.com"])).toEqual({ allowedHosts: ["a.com"] });
    expect(convert(true)).toEqual({ allowedHosts: true });
    expect(convert("all")).toEqual({ allowedHosts: true });
  });
});
