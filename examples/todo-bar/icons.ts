// Icons: SF Symbols in the Mac app, small SVGs in a tab (Apple's license
// keeps SF Symbols on Apple platforms). Either way the icon is a CSS mask,
// so it takes the text color.
import { symbol } from "steambun/ui";

const svg = (body: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`,
  )}`;

/** SF Symbol name → the tab's stand-in. */
const web: Record<string, string> = {
  "plus.circle.fill": svg(
    `<circle cx="12" cy="12" r="10" fill="black"/><path d="M12 7v10M7 12h10" stroke="white"/>`,
  ),
  sparkles: svg(
    `<path d="M10 3l1.8 5.2L17 10l-5.2 1.8L10 17l-1.8-5.2L3 10l5.2-1.8z"/><path d="M18 3v4M16 5h4"/>`,
  ),
  bell: svg(`<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>`),
  "bell.fill": svg(
    `<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z" fill="black"/><path d="M10 21h4"/>`,
  ),
  "square.and.arrow.up": svg(
    `<path d="M12 3v12M8 7l4-4 4 4"/><path d="M7 10H5v11h14V10h-2"/>`,
  ),
  trash: svg(`<path d="M4 6h16M9 6V4h6v2M6 6l1 15h10l1-15"/>`),
  gearshape: svg(
    `<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>`,
  ),
  checklist: svg(
    `<path d="M3 6l2 2 3-3M3 13l2 2 3-3"/><path d="M11 7h10M11 14h10M11 20h10"/>`,
  ),
  "checkmark.circle": svg(
    `<circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-6"/>`,
  ),
};

/** A masked icon element. `size` is in points. */
export function icon(
  name: string,
  size = 14,
  weight: "regular" | "medium" | "semibold" = "regular",
) {
  const el = document.createElement("i");
  el.className = "icon";
  el.setAttribute("aria-hidden", "true");
  const url = symbol(name, { size, weight }) ?? web[name] ?? "";
  el.style.setProperty("--icon", `url("${url}")`);
  el.style.setProperty("--size", `${size}px`);
  return el;
}
