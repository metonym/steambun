// SF Symbols in the page. In the Mac app, `symbol()` gives a URL the
// shell draws (SymbolScheme.swift). Use it as a CSS mask, so the icon
// takes the text color:
//
//   .icon { background: currentColor; mask: var(--icon) center / contain no-repeat; }
//   el.style.setProperty("--icon", `url("${symbol("checklist")}")`);
//
// In a tab it gives null: Apple's license allows SF Symbols only on Apple
// platforms, so draw your own icon there.

export interface SymbolOptions {
  /** Point size. Default 16. The PNG is drawn at 2x. */
  size?: number;
  weight?:
    | "ultralight"
    | "thin"
    | "light"
    | "regular"
    | "medium"
    | "semibold"
    | "bold"
    | "heavy"
    | "black";
}

/** A URL for an SF Symbol, or null outside the Mac app. */
export function symbol(name: string, o: SymbolOptions = {}): string | null {
  if (document.documentElement.dataset.shell !== "mac") return null;
  const q = new URLSearchParams();
  if (o.size !== undefined) q.set("size", String(o.size));
  if (o.weight) q.set("weight", o.weight);
  const s = q.toString();
  return `sf-symbol:${encodeURIComponent(name)}${s ? `?${s}` : ""}`;
}
