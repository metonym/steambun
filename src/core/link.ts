// The link to the native shell, and the page backend that uses it.
//
// The shell opens a WebSocket to /_steambun/ws once the core is ready, with
// the token it put in our environment (STEAMBUN_TOKEN). Over it the core
// drives real WKWebViews that the shell places over the browser pane.
//
//   core → shell  {"id","op","page","args"}         a call
//   shell → core  {"id","ok":true,"result"}         its reply
//                 {"id","ok":false,"error"}
//                 {"ev":"meta","page","url","title","loading"}
//                 {"ev":"log","page","entries":[...]}
//                 {"ev":"error","page","message"}   a failed load
//                 {"ev":"system","asleep","online","lowPower"}
//                                                   on link, and on change
//
// Screenshots come back as base64 in `result`.

import type { ServerWebSocket } from "bun";
import type { CorePayload } from "../bridge.ts";
import { detail } from "./log.ts";
import {
  addLogs,
  type LogEntry,
  type Meta,
  type Mod,
  type Page,
  PROBE,
} from "./page.ts";

export interface LinkData {
  steambun: "link";
}
type Sock = ServerWebSocket<LinkData>;
interface Call {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

const CALL_MS = 35_000;

const g = globalThis as {
  __steambun?: {
    sock: Sock | null;
    seq: number;
    calls: Map<number, Call>;
    pages: Map<string, NativePage>;
    waiting: Set<() => void>;
    token: string;
  };
};
// On globalThis so a hot reload keeps the live link.
const link = (g.__steambun ??= {
  sock: null,
  seq: 0,
  calls: new Map(),
  pages: new Map(),
  waiting: new Set(),
  token: process.env.STEAMBUN_TOKEN ?? "",
});
const TOKEN = link.token;
// Terminals inherit our environment; they must not get the shell's token.
delete process.env.STEAMBUN_TOKEN;

/** True if the request carries the shell's token and comes from loopback. */
export function nativeAuth(req: Request, ip: string | undefined): boolean {
  if (!TOKEN) return false;
  if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1")
    return false;
  const got = Buffer.from(req.headers.get("x-steambun-token") ?? "");
  const want = Buffer.from(TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** The shell can host pages: it is running and linked. */
export const nativeLinked = () => !!link.sock;

/** Wait up to `ms` for the shell to link (it links right after startup). */
export function waitLinked(ms = 3000): Promise<boolean> {
  if (link.sock) return Promise.resolve(true);
  if (!TOKEN) return Promise.resolve(false);
  return new Promise((done) => {
    const f = () => {
      clearTimeout(t);
      link.waiting.delete(f);
      done(!!link.sock);
    };
    const t = setTimeout(f, ms);
    link.waiting.add(f);
  });
}

function call<T = unknown>(op: string, page: string, args: object = {}) {
  const ws = link.sock;
  if (!ws) return Promise.reject(new Error("native shell not linked"));
  const id = ++link.seq;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      link.calls.delete(id);
      reject(new Error(`native ${op}: no reply`));
    }, CALL_MS);
    link.calls.set(id, {
      resolve: (v) => (clearTimeout(t), resolve(v as T)),
      reject: (e) => (clearTimeout(t), reject(e)),
    });
    ws.send(JSON.stringify({ id, op, page, args }));
  });
}

/**
 * A menu bar app's title and icon (an SF Symbol name). Works with the
 * panel closed and no page loaded. Unset fields stay as they are.
 * Resolves false if no shell links, as under `steambun dev` in a tab.
 */
export async function setMenuBar(m: {
  title?: string;
  icon?: string;
}): Promise<boolean> {
  // Right after launch, the shell may not have linked yet.
  if (!(await waitLinked())) return false;
  await call("menuBar", "", m);
  return true;
}

export class NativePage implements Page {
  readonly kind = "native";
  readonly ready: Promise<void>;
  onMeta: ((m: Meta) => void) | null = null;
  onLog: ((e: LogEntry[]) => void) | null = null;
  onError: ((message: string) => void) | null = null;
  private m: Meta = { url: "", title: "", loading: false };
  private ring: LogEntry[] = [];

  constructor(readonly id: string) {
    link.pages.set(id, this);
    this.ready = call("open", id, { probe: PROBE }).then(() => {});
  }

  meta() {
    return this.m;
  }
  setMeta(m: Meta) {
    this.m = m;
    this.onMeta?.(m);
  }
  addLogs(e: LogEntry[]) {
    addLogs(this, this.ring, e);
  }

  private op<T = void>(op: string, args?: object) {
    return this.ready.then(() => call<T>(op, this.id, args));
  }
  navigate(url: string) {
    return this.op("navigate", { url });
  }
  back() {
    return this.op("back");
  }
  forward() {
    return this.op("forward");
  }
  reload() {
    return this.op("reload");
  }
  evaluate<T = unknown>(expr: string) {
    return this.op<T>("eval", { expr });
  }
  async screenshot(format: "jpeg" | "png" = "png", quality = 80) {
    const b64 = await this.op<string>("screenshot", { format, quality });
    return Buffer.from(b64, "base64");
  }
  click(x: number, y: number, o: { count?: number; mods?: Mod[] } = {}) {
    return this.op("click", { x, y, count: o.count ?? 1, mods: o.mods ?? [] });
  }
  type(text: string) {
    return this.op("type", { text });
  }
  press(key: string, mods: Mod[] = []) {
    return this.op("press", { key, mods });
  }
  scroll(dx: number, dy: number) {
    return this.op("scroll", { dx, dy });
  }
  resize(w: number, h: number) {
    return this.op("resize", { w, h });
  }
  async logs() {
    return this.ring.slice();
  }
  close() {
    link.pages.delete(this.id);
    call("close", this.id).catch(() => {});
  }
}

export const nativeSocket = {
  open(ws: Sock) {
    if (link.sock && link.sock !== ws) link.sock.close(1000, "replaced");
    link.sock = ws;
    detail("native", "shell linked");
    for (const f of link.waiting) f();
  },
  message(_ws: Sock, raw: string | Buffer) {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (typeof m.id === "number") {
      const c = link.calls.get(m.id);
      if (!c) return;
      link.calls.delete(m.id);
      if (m.ok) c.resolve(m.result);
      else c.reject(new Error(String(m.error ?? "native call failed")));
      return;
    }
    if (m.ev === "system") return emitSystem(systemState(m));
    const p = link.pages.get(String(m.page));
    if (!p) return;
    if (m.ev === "meta")
      p.setMeta({
        url: String(m.url ?? ""),
        title: String(m.title ?? ""),
        loading: !!m.loading,
      });
    else if (m.ev === "error") p.onError?.(String(m.message ?? ""));
    else if (m.ev === "log" && Array.isArray(m.entries))
      p.addLogs(m.entries as LogEntry[]);
  },
  close(ws: Sock) {
    if (link.sock !== ws) return;
    link.sock = null;
    detail("native", "shell unlinked");
    for (const c of link.calls.values())
      c.reject(new Error("native shell unlinked"));
    link.calls.clear();
    // The pages went with the shell; their sessions must close.
    const pages = [...link.pages.values()];
    link.pages.clear();
    for (const p of pages) p.onMeta = p.onLog = null;
    onUnlink?.(pages.map((p) => p.id));
    // No shell, no signals: back to unknown.
    emitSystem(null);
  },
};

const systemState = (m: Record<string, unknown>): CorePayload<"system"> => ({
  asleep: m.asleep === true,
  online: m.online !== false,
  lowPower: m.lowPower === true,
});

type SystemFn = (s: CorePayload<"system"> | null) => void;
const systemFns = new Set<SystemFn>();
/**
 * The Mac's state: sleep, network, Low Power Mode. Called on link and on
 * each change; null when the shell goes away. Returns an unsubscribe.
 */
export function onSystem(f: SystemFn): () => void {
  systemFns.add(f);
  return () => systemFns.delete(f);
}
const emitSystem = (s: CorePayload<"system"> | null) => {
  for (const f of systemFns) f(s);
};

let onUnlink: ((ids: string[]) => void) | null = null;
/** browser.ts closes the sessions of pages that died with the shell. */
export function setOnUnlink(f: (ids: string[]) => void) {
  onUnlink = f;
}
