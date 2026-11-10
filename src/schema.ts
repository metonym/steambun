// The schema language for bridges: types that carry both their TS type and
// their Swift type. steambun/bridge.ts declares the framework's ops with it; an
// app declares its own in a bridge file (steambun.config.ts → `bridge`):
//
//   import { defineBridge, op, t } from "steambun/schema";
//   export default defineBridge({
//     ops: {
//       "notes.reveal": op(t.struct("NotesRevealArgs", { path: t.string }), t.bool),
//     },
//     events: { "notes.changed": t.struct("NotesChanged", { path: t.string }) },
//   });
//
// The build generates a Swift protocol from it with one method per op, so
// the Swift build fails until the app's Swift code handles every op.

/** A type in the schema. `T` is the TS type; `swift` is the Swift one. */
export interface Ty<T> {
  swift: string;
  opt?: true;
  fields?: Record<string, Ty<unknown>>;
  name?: string;
  /** The element type of a list, map or opt. */
  of?: Ty<unknown>;
  /** Phantom: carries the TS type only. */
  _v?: T;
}
export type V<T> = T extends Ty<infer X> ? X : never;
type OptKeys<S> = {
  [K in keyof S]: S[K] extends { opt: true } ? K : never;
}[keyof S];
type Shape<S extends Record<string, Ty<unknown>>> = {
  [K in Exclude<keyof S, OptKeys<S>>]: V<S[K]>;
} & { [K in OptKeys<S>]?: V<S[K]> | null };

/** A type with a Swift spelling of your own, such as `ty<unknown>("Any")`. */
export const ty = <X>(swift: string): Ty<X> => ({ swift });

export const t = {
  string: ty<string>("String"),
  number: ty<number>("Double"),
  int: ty<number>("Int"),
  bool: ty<boolean>("Bool"),
  /** No args, or no result. */
  none: ty<void>("Void"),
  list: <X>(x: Ty<X>): Ty<X[]> => ({ swift: `[${x.swift}]`, of: x }),
  map: <X>(x: Ty<X>): Ty<Record<string, X>> => ({
    swift: `[String: ${x.swift}]`,
    of: x,
  }),
  /** May be missing or null. */
  opt: <X>(x: Ty<X>) =>
    ({ swift: `${x.swift}?`, opt: true, of: x }) as Ty<X> & { opt: true },
  struct: <S extends Record<string, Ty<unknown>>>(name: string, fields: S) =>
    ({ swift: name, name, fields }) as Ty<Shape<S>>,
};

export interface Op {
  args: Ty<unknown>;
  result: Ty<unknown>;
  /** The Swift method is `async throws`; the page's call waits for it. */
  async?: boolean;
}
/**
 * An op: what it takes and what it returns. `t.none` for nothing.
 * `{ async: true }` for work that takes time, such as a model or a
 * network call: the Swift method is `async throws` and runs on the main
 * actor, and the page's `native.call` resolves when it returns.
 */
export const op = <A, R>(
  args: Ty<A>,
  result: Ty<R>,
  opts: { async?: boolean } = {},
) => ({ args, result, ...(opts.async ? { async: true } : {}) });

/** Page → shell ops, and shell → page events. */
export interface Bridge {
  ops: Record<string, Op>;
  events: Record<string, Ty<unknown>>;
}

/** An app's bridge. Both parts are optional. */
export function defineBridge<
  O extends Record<string, Op> = Record<never, never>,
  E extends Record<string, Ty<unknown>> = Record<never, never>,
>(b: { ops?: O; events?: E }): { ops: O; events: E } {
  return { ops: b.ops ?? ({} as O), events: b.events ?? ({} as E) };
}

export type ArgsOf<O extends Op> = V<O["args"]>;
export type ResultOf<O extends Op> = V<O["result"]>;
