// The page's one way to talk to the native shell. Plain TS: no framework.
//
//   native.has("menu.setKeys")            does this shell support the op?
//   await native.call("app.info")         call it; the shell replies
//   const off = native.on("screen.hz", f) hear an event
//   native.watch("screen.hz", f)          the same, plus the last one now
//   native.command("hi", f)               a menu item's command
//
// Outside the shell (a browser tab, the sheets), `has` is false and `call`
// rejects with NativeUnavailable, so callers check `has` or catch.
// The ops and events are the framework's (steambun/bridge.ts) plus the
// app's. An app types its own by registering its bridge once:
//
//   declare module "steambun/ui" {
//     interface Register { bridge: typeof bridge }
//   }
import type { PAGE_OPS, SHELL_EVENTS } from "../bridge.ts";
import type { ArgsOf, ResultOf, V } from "../schema.ts";

/** Augmented by the app: `interface Register { bridge: typeof myBridge }`. */
// biome-ignore lint: an empty interface is the point
export interface Register {}
type AppBridge = Register extends { bridge: infer B }
  ? B
  : { ops: {}; events: {} };
type AppOps = AppBridge extends { ops: infer O } ? O : {};
type AppEvents = AppBridge extends { events: infer E } ? E : {};

type Ops = typeof PAGE_OPS & AppOps;
type Events = typeof SHELL_EVENTS & AppEvents;
export type PageOp = keyof Ops & string;
export type PageArgs<K extends PageOp> = ArgsOf<Ops[K]>;
export type PageResult<K extends PageOp> = ResultOf<Ops[K]>;
export type ShellEvent = keyof Events & string;
export type ShellPayload<K extends ShellEvent> = V<Events[K]>;

export class NativeUnavailable extends Error {
  constructor(op: string) {
    super(`native op ${op}: not in this shell`);
  }
}

/** What the shell's boot script puts on window, before any page code. */
type Hub = {
  ops: string[];
  /** The shell runs a test: expose test handles. */
  test: boolean;
  /** Events that came before this module loaded. */
  q: [string, unknown][];
  emit(name: string, payload: unknown): void;
};
type Handler = { postMessage(m: unknown): Promise<unknown> };

const g = globalThis as {
  __steambun?: Hub;
  webkit?: { messageHandlers?: { steambun?: Handler } };
};
const hub = g.__steambun;
const handler = g.webkit?.messageHandlers?.steambun;

const subs = new Map<string, Set<(p: unknown) => void>>();
const last = new Map<string, unknown>();

function deliver(name: string, payload: unknown) {
  last.set(name, payload);
  for (const f of subs.get(name) ?? []) f(payload);
}

if (hub) {
  for (const [n, p] of hub.q.splice(0)) deliver(n, p);
  hub.emit = deliver;
}

type ArgList<K extends PageOp> =
  PageArgs<K> extends void ? [] : [args: PageArgs<K>];

export const native = {
  /** True inside the native shell. */
  inShell: !!(hub && handler),
  /** The shell runs a test: expose handles like the terminal's. */
  test: !!hub?.test,

  has(op: PageOp): boolean {
    return !!handler && !!hub?.ops.includes(op);
  },

  call<K extends PageOp>(op: K, ...a: ArgList<K>): Promise<PageResult<K>> {
    if (!native.has(op)) return Promise.reject(new NativeUnavailable(op));
    return handler!.postMessage({ op, args: a[0] ?? {} }) as Promise<
      PageResult<K>
    >;
  },

  /** Call and forget: no-op outside the shell, errors go to the console. */
  send<K extends PageOp>(op: K, ...a: ArgList<K>): void {
    if (native.has(op)) native.call(op, ...a).catch(console.error);
  },

  on<K extends ShellEvent>(
    name: K,
    f: (p: ShellPayload<K>) => void,
  ): () => void {
    let set = subs.get(name);
    if (!set) subs.set(name, (set = new Set()));
    const fn = f as (p: unknown) => void;
    set.add(fn);
    return () => set.delete(fn);
  },

  /** Like `on`, but first calls `f` with the last payload, if one came. */
  watch<K extends ShellEvent>(
    name: K,
    f: (p: ShellPayload<K>) => void,
  ): () => void {
    if (last.has(name)) f(last.get(name) as ShellPayload<K>);
    return native.on(name, f);
  },

  /** Run `f` when the menu item with this command is chosen. */
  command(id: string, f: () => void): () => void {
    return native.on("menu.command" as ShellEvent, (e) => {
      if ((e as { id?: string }).id === id) f();
    });
  },

  /** The last payload of an event, if one came. */
  last<K extends ShellEvent>(name: K): ShellPayload<K> | undefined {
    return last.get(name) as ShellPayload<K> | undefined;
  },
};
