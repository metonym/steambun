// Multi-page app: any second *.html file at the project root is discovered
// and routed automatically (here, /about) — no rollupOptions.input needed.
document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <nav class="mb-4"><a class="mr-4 text-blue-600 underline" href="/">index</a><a class="text-blue-600 underline" href="/about">about</a></nav>
  <h1 class="text-2xl font-bold">about</h1>
  <p class="text-slate-600">A second HTML entrypoint, auto-routed to /about.</p>
`;
