import { group, task } from "ostia";
import { createProxyRouteHandler } from "../src/runtime/proxy";

// The proxy handler calls the global `fetch` for every forwarded request —
// stub it once for the whole file so these benchmarks measure our own
// URL/header construction overhead, not real network I/O. The response
// carries a realistic upstream header set (including a couple of
// hop-by-hop ones) so every task exercises response-side header stripping
// too, not just the request side.
const UPSTREAM_RESPONSE = new Response("ok", {
  headers: {
    "content-type": "application/json",
    "cache-control": "no-store",
    connection: "keep-alive",
    "transfer-encoding": "chunked",
    "x-request-id": "abc",
    vary: "Origin",
    "set-cookie": "a=b; Path=/",
    date: "Mon, 08 Sep 2026 00:00:00 GMT",
    server: "up",
    etag: '"x"',
  },
});
// biome-ignore lint/suspicious/noExplicitAny: overriding the global for benchmarking
(globalThis as any).fetch = async () => UPSTREAM_RESPONSE.clone();

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

// Realistic browser request headers, including a couple of hop-by-hop ones,
// so stripHopByHopHeaders and the duplicate-URL-parse fix have something
// representative to measure against — the existing tasks above reuse a
// header-less Request across trials, which hides that cost entirely.
const BROWSER_HEADERS = {
  accept: "application/json, text/plain, */*",
  "accept-encoding": "gzip, deflate, br, zstd",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  connection: "keep-alive",
  cookie: "session=abcdef0123456789; theme=dark",
  host: "localhost:5173",
  origin: "http://localhost:5173",
  referer: "http://localhost:5173/app",
  "user-agent": "Mozilla/5.0 (Macintosh) Chrome/140",
  "sec-fetch-mode": "cors",
  te: "trailers",
};

group("runtime/proxy: realistic headers (per-request hot path)", () => {
  const handler = createProxyRouteHandler("/api", {
    target: "http://localhost:4100",
    changeOrigin: true,
  });
  // A fresh Request per trial — the groups above reuse one Request across
  // trials (fine there since headers are minimal), but that would hide
  // per-request Request construction cost for a realistic header set.
  const req = () =>
    new Request("http://localhost:5173/api/users/42?sort=asc", {
      headers: BROWSER_HEADERS,
    });

  task(
    "C1 changeOrigin, 12 req headers (2 hop-by-hop), 10 res headers (2 hop-by-hop)",
    () => handler(req(), fakeServer),
  );
});
