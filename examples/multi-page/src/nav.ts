// Imported by index.ts, about.ts, and blog.ts — with build.splitting this
// becomes its own chunk; with build.importMap, editing it re-hashes only
// this file instead of every page that imports it.
export type Page = "index" | "about" | "blog";

export function nav(active: Page): string {
  const link = (page: Page, href: string, label: string) =>
    `<a href="${href}"${page === active ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<nav>${link("index", "/", "index")} · ${link("about", "/about", "about")} · ${link("blog", "/blog", "blog")}</nav>`;
}
