// Shared by main.ts and about.ts; build.splitting makes it its own chunk.
export function nav(active: "index" | "about"): string {
  const cls = (page: "index" | "about") =>
    page === active
      ? "mr-4 font-semibold text-blue-600 underline"
      : "mr-4 text-blue-600 underline";
  return `<nav class="mb-4"><a class="${cls("index")}" href="/">index</a><a class="${cls("about")}" href="/about">about</a></nav>`;
}
