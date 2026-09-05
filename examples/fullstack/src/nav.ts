// Shared by main.ts and about.ts — with build.splitting + build.importMap,
// this becomes its own chunk that both pages import by a stable id, so
// editing it re-hashes one file instead of every page that uses it.
export function nav(active: "index" | "about"): string {
  const cls = (page: "index" | "about") =>
    page === active
      ? "mr-4 font-semibold text-blue-600 underline"
      : "mr-4 text-blue-600 underline";
  return `<nav class="mb-4"><a class="${cls("index")}" href="/">index</a><a class="${cls("about")}" href="/about">about</a></nav>`;
}
