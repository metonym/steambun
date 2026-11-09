// Dev only: keep scroll positions, typed text and focus across hot updates.
// Works with any UI framework: it only reads and writes the DOM.
//
//   // in the page entry. Bun wants import.meta.hot.on() written in place.
//   if (import.meta.hot) {
//     const keep = keeper();               // or keeper({ ignoreClass: /^css-/ })
//     import.meta.hot.on("bun:beforeUpdate", keep.beforeUpdate);
//     import.meta.hot.on("bun:afterUpdate", keep.afterUpdate);
//   }
//
// HMR remounts the edited component, so its DOM is new: scrollTop goes
// back to 0 and focus is lost. Before Bun applies an update, record
// every scrolled element and the focused input by a stable key. After the
// update, put them back. Content can load a frame or two late (cache reads,
// virtual lists), so retry until the position sticks.

type Key = string;

export type KeepOptions = {
  /**
   * Classes to leave out of an element's key: scoped-style hashes that
   * change when the styles change. Default: Svelte's (`svelte-…`).
   */
  ignoreClass?: RegExp;
};

let ignore = /^svelte-/;

// tag.class (minus scoped hashes) plus its index among elements with the
// same signature.
function keys(root: ParentNode = document): Map<Element, Key> {
  const seen = new Map<string, number>();
  const out = new Map<Element, Key>();
  for (const el of root.querySelectorAll("*")) {
    const cls = [...el.classList]
      .filter((c) => !ignore.test(c))
      .sort()
      .join(".");
    const sig = `${el.tagName}.${cls}`;
    const n = seen.get(sig) ?? 0;
    seen.set(sig, n + 1);
    out.set(el, `${sig}#${n}`);
  }
  return out;
}

type Snap = {
  scroll: Map<Key, [number, number]>;
  text: Map<Key, string>;
  focus: { key: Key; start: number | null; end: number | null } | null;
};

function snap(): Snap {
  const scroll = new Map<Key, [number, number]>();
  const text = new Map<Key, string>();
  let focus: Snap["focus"] = null;
  const active = document.activeElement;
  for (const [el, key] of keys()) {
    if (el.scrollTop || el.scrollLeft)
      scroll.set(key, [el.scrollTop, el.scrollLeft]);
    if (isText(el) && el.value) text.set(key, el.value);
    if (el === active && el !== document.body) {
      const input = el as HTMLInputElement;
      focus = {
        key,
        start: "selectionStart" in input ? input.selectionStart : null,
        end: "selectionEnd" in input ? input.selectionEnd : null,
      };
    }
  }
  return { scroll, text, focus };
}

const isText = (el: Element): el is HTMLInputElement | HTMLTextAreaElement =>
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLInputElement &&
    /^(text|search|url|email|)$/.test(el.type));

function restore(s: Snap, done: () => void) {
  // Text first: a filter changes what the list shows, and so how far it scrolls.
  // The input event updates any bind:value behind the field.
  const byKey0 = new Map([...keys()].map(([el, k]) => [k, el]));
  for (const [key, value] of s.text) {
    const el = byKey0.get(key);
    if (el && isText(el) && el.value !== value) {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  const deadline = performance.now() + 1000;
  const tick = () => {
    const byKey = new Map([...keys()].map(([el, k]) => [k, el]));
    let pending = 0;
    for (const [key, [top, left]] of s.scroll) {
      const el = byKey.get(key);
      if (!el) continue;
      el.scrollTop = top;
      el.scrollLeft = left;
      // Not tall enough yet: content still loading. Try again next frame.
      if (
        Math.abs(el.scrollTop - top) > 1 ||
        Math.abs(el.scrollLeft - left) > 1
      )
        pending++;
      else s.scroll.delete(key);
    }
    if (s.focus) {
      const el = byKey.get(s.focus.key) as HTMLInputElement | undefined;
      if (el) {
        if (document.activeElement !== el) el.focus({ preventScroll: true });
        // Even if it has focus already: setting the text moved the caret.
        if (s.focus.start !== null)
          el.setSelectionRange?.(s.focus.start, s.focus.end);
      }
      if (el) s.focus = null;
    }
    if ((pending || s.focus) && performance.now() < deadline)
      requestAnimationFrame(tick);
    else done();
  };
  requestAnimationFrame(tick);
}

// Svelte swaps in the new component a little after Bun's afterUpdate, so
// wait until the DOM has been quiet for one frame (at most 500 ms).
function settled(then: () => void) {
  let last = performance.now();
  const start = last;
  const mo = new MutationObserver(() => (last = performance.now()));
  mo.observe(document.body, { childList: true, subtree: true });
  const check = () => {
    const now = performance.now();
    if (now - last > 32 || now - start > 500) {
      mo.disconnect();
      then();
    } else requestAnimationFrame(check);
  };
  requestAnimationFrame(check);
}

/** The two hooks to register on Bun's HMR events. */
export function keeper(opts: KeepOptions = {}) {
  if (opts.ignoreClass) ignore = opts.ignoreClass;
  // One snapshot until it's put back. A second update that lands before
  // then (a save, then an undo) would snapshot the half-built DOM: empty
  // fields, no focus, scroll at 0. Keep the first one instead.
  let saved: Snap | null = null;
  // The snapshot being put back. Text comes back at once, but focus and
  // scroll wait for frames; an update in that gap would snapshot text with
  // no focus. Reuse this one instead.
  let restoring: Snap | null = null;
  let gen = 0;
  return {
    beforeUpdate() {
      saved ??= restoring ?? snap();
      gen++;
    },
    afterUpdate() {
      const mine = ++gen;
      settled(() => {
        if (mine !== gen || !saved) return; // a newer update will restore
        const s = saved;
        saved = null;
        restoring = s;
        // restore() uses up its copy; keep s whole in case it's needed again.
        const copy: Snap = {
          scroll: new Map(s.scroll),
          text: new Map(s.text),
          focus: s.focus && { ...s.focus },
        };
        restore(copy, () => {
          if (restoring === s) restoring = null;
        });
      });
    },
  };
}
