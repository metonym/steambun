// serve(): Bun.serve with the framework's parts already in place.
//
//   import { serve } from "steambun/core";
//   import page from "./index.html";
//   serve({ port: 4317, routes: { "/": page, "/api/hello": () => Response.json("hi") } });
//
// Everything Bun.serve takes still works. On top, serve() adds:
//
//   /_steambun/ws           the native shell's link (token-checked)
//   /_steambun/settings     durable UI settings (`settings: false` to drop)
//   /_steambun/browser/…    browser panes and their agent API (`browser: false`)
//   trusted()               a 403 for other websites, on every route
//   STEAMBUN_READY <port>   on stdout once listening, under the shell only
//   parent watch            exit when the shell dies, even by kill -9
//
// The app's own sockets keep their own data; the framework's are told
// apart by `data.steambun`, so one websocket handler serves both.
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import {
  api as browserApi,
  type BrowserData,
  browserSocket,
} from "./browser.ts";
import { type LinkData, nativeAuth, nativeSocket } from "./link.ts";
import { log } from "./log.ts";
import { jsonSettings, settingsRoute, type SettingsStore } from "./settings.ts";

type Framework = LinkData | BrowserData;

export interface ServeOptions<T, R extends string = string> {
  /** Port when the shell didn't choose one (STEAMBUN_PORT). Default 3000. */
  port?: number;
  /** Bun routes: typed params, per-method handlers, HTML imports. */
  routes?: Bun.Serve.RoutesWithUpgrade<T, R>;
  /** Called for what no route and no framework path matched. */
  fetch?: (
    req: Request,
    server: Server<T>,
  ) =>
    Response | Promise<Response> | void | undefined | Promise<void | undefined>;
  /**
   * The app's sockets. Set `data: {} as MyData` to type ws.data (it also
   * keeps route params typed; TS can't infer half the generics).
   */
  websocket?: WebSocketHandler<T>;
  /** Where UI settings live. Default: settings.json in the app's home. */
  settings?: SettingsStore | false;
  /**
   * Browser panes. `auth` lets a non-page caller (an agent, a CLI) use
   * the API; pages of this origin always may.
   */
  browser?: false | { auth?: (req: Request) => boolean };
  /** Passed on to Bun.serve. */
  idleTimeout?: number;
  development?: boolean | { hmr?: boolean; console?: boolean };
  /** Log "serving <url>". Default true. */
  quiet?: boolean;
}

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/**
 * Stricter than trusted(): the request must come from a page on this
 * server. Use it for routes that only the app's own page calls, such as
 * one that runs a command. Local processes send no Origin, so they fail.
 */
export function sameOrigin(req: Request): boolean {
  const host = req.headers.get("host") ?? "";
  if (!LOOPBACK.test(host)) return false;
  return req.headers.get("origin") === `http://${host}`;
}

/**
 * The gate serve() puts in front of every request. The server listens on
 * loopback, but a web page in any browser can still reach it. Two attacks:
 *
 * - DNS rebinding: a site points its own name at 127.0.0.1 and reads our
 *   replies. Its requests carry its own Host, so we accept loopback names only.
 * - Cross-site requests: a site posts to us, or opens a socket. Browsers
 *   send Origin and Sec-Fetch-Site on these, so we refuse any other site.
 *
 * A request with neither header comes from a local process (an agent,
 * the CLI, a test), which already runs as the user. A cross-site link
 * may still open a page (a GET navigation), so a GET route must not write.
 */
export function trusted(req: Request): boolean {
  const host = req.headers.get("host") ?? "";
  if (!LOOPBACK.test(host)) return false;
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  const ours =
    (!origin || origin === `http://${host}`) &&
    (!site || site === "same-origin" || site === "none");
  if (ours) return true;
  return (
    (req.method === "GET" || req.method === "HEAD") &&
    req.headers.get("sec-fetch-mode") === "navigate" &&
    !req.headers.get("upgrade")
  );
}

const forbidden = () => new Response("forbidden", { status: 403 });

const METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
type Handler = (req: Request, srv: unknown) => unknown;

/** Put trusted() in front of one route: a handler or a method map. */
function guard(v: unknown): unknown {
  if (typeof v === "function")
    return (req: Request, srv: unknown) =>
      trusted(req) ? (v as Handler)(req, srv) : forbidden();
  if (
    v &&
    typeof v === "object" &&
    !(v instanceof Response) &&
    Object.keys(v).length > 0 &&
    Object.keys(v).every((k) => METHODS.has(k))
  )
    return Object.fromEntries(Object.entries(v).map(([k, h]) => [k, guard(h)]));
  // A static Response or an HTML bundle: Bun serves these before our code
  // runs, and they are the same for every caller.
  return v;
}

const isOurs = (
  ws: ServerWebSocket<unknown>,
): ws is ServerWebSocket<Framework> =>
  !!(ws.data as { steambun?: string } | undefined)?.steambun;

export function serve<T = undefined, R extends string = never>(
  opts: ServeOptions<T, R> = {},
): Server<T> {
  const settings =
    opts.settings === false ? null : (opts.settings ?? jsonSettings());
  const browser = opts.browser === false ? null : (opts.browser ?? {});
  const app = opts.websocket;

  const routes: Record<string, unknown> = { ...opts.routes };
  if (settings) routes["/_steambun/settings"] = settingsRoute(settings);
  if (browser)
    routes["/_steambun/browser/:op"] = {
      POST: async (req: Request & { params: { op: string } }) => {
        if (!sameOrigin(req) && !browser.auth?.(req)) return forbidden();
        const b = await req.json().catch(() => ({}));
        return browserApi(
          req.params.op,
          b && typeof b === "object" ? b : {},
        ).catch((e) =>
          Response.json(
            { ok: false, error: (e as Error).message },
            { status: 500 },
          ),
        );
      },
    };

  const server = Bun.serve({
    // "0" asks for any free port (the test harness).
    port: process.env.STEAMBUN_PORT
      ? Number(process.env.STEAMBUN_PORT)
      : (opts.port ?? 3000),
    hostname: "127.0.0.1",
    idleTimeout: opts.idleTimeout,
    development: opts.development,
    routes: Object.fromEntries(
      Object.entries(routes).map(([k, v]) => [k, guard(v)]),
    ),
    fetch(req, srv) {
      if (!trusted(req)) return forbidden();
      const path = new URL(req.url).pathname;
      if (path === "/_steambun/ws") {
        if (!nativeAuth(req, srv.requestIP(req)?.address)) return forbidden();
        const data: LinkData = { steambun: "link" };
        if (srv.upgrade(req, { data })) return;
      }
      if (browser && path === "/_steambun/browser/ws") {
        if (!sameOrigin(req)) return forbidden();
        const q = new URL(req.url).searchParams;
        const data: BrowserData = {
          steambun: "browser",
          browser: (q.get("id") || "main").slice(0, 64),
          native: q.get("native") === "1",
        };
        if (srv.upgrade(req, { data })) return;
      }
      const r = opts.fetch?.(req, srv as unknown as Server<T>);
      return r ?? new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        if (!isOurs(ws)) return app?.open?.(ws as ServerWebSocket<T>);
        if (ws.data.steambun === "link")
          nativeSocket.open(ws as ServerWebSocket<LinkData>);
        else browserSocket.open(ws as ServerWebSocket<BrowserData>);
      },
      message(ws, raw) {
        if (!isOurs(ws)) return app?.message?.(ws as ServerWebSocket<T>, raw);
        if (ws.data.steambun === "link")
          nativeSocket.message(ws as ServerWebSocket<LinkData>, raw);
        else browserSocket.message(ws as ServerWebSocket<BrowserData>, raw);
      },
      close(ws, code, reason) {
        if (!isOurs(ws))
          return app?.close?.(ws as ServerWebSocket<T>, code, reason);
        if (ws.data.steambun === "link")
          nativeSocket.close(ws as ServerWebSocket<LinkData>);
        else browserSocket.close(ws as ServerWebSocket<BrowserData>);
      },
      drain:
        app?.drain &&
        ((ws) => !isOurs(ws) && app.drain!(ws as ServerWebSocket<T>)),
    },
  } as Parameters<typeof Bun.serve>[0]) as unknown as Server<T>;

  if (!opts.quiet) log("serve", `serving ${server.url}`);
  // Run by the shell: it waits for this line instead of polling, and we
  // exit when it dies, even by kill -9, which reparents us to launchd.
  const parent = Number(process.env.STEAMBUN_PARENT_PID);
  if (parent) console.log(`STEAMBUN_READY ${server.port}`);
  if (parent)
    setInterval(() => {
      if (process.ppid !== parent) process.exit(0);
    }, 1000).unref();
  return server;
}
