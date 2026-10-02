// Imported by index.ts, about.ts, and blog.ts; build.splitting makes it its own chunk.
export type Page = "index" | "about" | "blog";

export function nav(active: Page): string {
  const link = (page: Page, href: string, label: string) =>
    `<a href="${href}"${page === active ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<nav>${link("index", "/", "index")} · ${link("about", "/about", "about")} · ${link("blog", "/blog", "blog")}</nav>`;
}
