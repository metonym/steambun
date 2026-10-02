import { group, task } from "ostia";
import { createProxyRouteHandler } from "../src/runtime/proxy";

// `fetch` is stubbed so these measure URL/header handling, not network I/O.
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

// Realistic browser headers (including hop-by-hop ones).
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
  // A fresh Request per trial.
  const req = () =>
    new Request("http://localhost:5173/api/users/42?sort=asc", {
      headers: BROWSER_HEADERS,
    });

  task(
    "C1 changeOrigin, 12 req headers (2 hop-by-hop), 10 res headers (2 hop-by-hop)",
    () => handler(req(), fakeServer),
  );
});
