import { group, task } from "ostia";
import { createProxyRouteHandler } from "../src/runtime/proxy";

// The proxy handler calls the global `fetch` for every forwarded request —
// stub it so these benchmarks measure our own URL/header construction
// overhead, not real network I/O.
const STUB_RESPONSE = new Response("ok");
// biome-ignore lint/suspicious/noExplicitAny: overriding the global for benchmarking
(globalThis as any).fetch = async () => STUB_RESPONSE.clone();

const fakeServer = { upgrade: () => false };

group("runtime/proxy: createProxyRouteHandler (per-request hot path)", () => {
  const plain = createProxyRouteHandler("/api", "http://localhost:4100");
  const withChangeOrigin = createProxyRouteHandler("/api", {
    target: "http://localhost:4100",
    changeOrigin: true,
  });
  const withRewrite = createProxyRouteHandler("/api", {
    target: "http://localhost:4100",
    rewrite: (path) => path.replace(/^\/legacy/, ""),
  });

  task("string target, no rewrite/changeOrigin", () =>
    plain(
      new Request("http://localhost:5173/api/users/42?sort=asc"),
      fakeServer,
    ),
  );

  task("object target with changeOrigin", () =>
    withChangeOrigin(
      new Request("http://localhost:5173/api/users/42?sort=asc"),
      fakeServer,
    ),
  );

  task("object target with rewrite", () =>
    withRewrite(
      new Request("http://localhost:5173/api/legacy/users/42?sort=asc"),
      fakeServer,
    ),
  );
});

group("runtime/proxy: createProxyRouteHandler (construction)", () => {
  task("construct handler (string entry)", () =>
    createProxyRouteHandler("/api", "http://localhost:4100"),
  );
});
