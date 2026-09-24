# steambun

Steambun is Bun's fullstack dev server plus Vite-style config. `steambun dev` starts `Bun.serve` with HMR. `steambun build` runs `Bun.build`. Both use Bun's bundler; steambun adds only what Bun does not:

- One config file that drives `dev`, `build`, `preview`, and `compile`
- Vite parity: `server.proxy` (HTTP and WebSocket), `publicDir`, `.env.[mode]` files, `import.meta.env.MODE`/`DEV`/`PROD`/`BASE_URL`, `base`, `resolve.alias`, `?raw`/`?url`/`?inline`, and `steambun migrate` from a `vite.config.*`
- File-based API and WebSocket routes, middleware, and a typed `api()` client, served in the same process as the frontend
- A production server (`preview`, `dist/server.js`, or a compiled binary) with cache headers, precompressed assets, and SPA fallback

## When you don't need steambun

Bun already covers the core on its own ([docs](https://bun.com/docs/bundler/fullstack)):

| You want | Plain Bun |
| --- | --- |
| Serve HTML with bundling and HMR | `bun ./index.html` (or `bun './**/*.html'`) |
| A production build | `bun build ./index.html --minify --outdir dist` |
| API routes next to the frontend | `Bun.serve({ routes: { "/": index, "/api/users/:id": handler } })` with `import index from "./index.html"` |
| Bundler plugins (Tailwind etc.) and public env vars | `[serve.static] plugins` / `env = "PUBLIC_*"` in `bunfig.toml` |
| A single-binary server | `bun build --compile` on that `Bun.serve` entry |

If that's enough, use Bun directly. Reach for steambun when you're moving off Vite, need a proxy or `publicDir`, want file-based routes instead of a hand-written route table, or want dev and prod driven from one config.

## Install

```bash
bun add -d steambun
```

Requires Bun >= 1.4.0 and at least one `*.html` file (usually `index.html` at the project root).

## Quick start

```ts
// steambun.config.ts
import { defineConfig } from "steambun";

export default defineConfig({
  server: { port: 5173 },
});
```

```bash
steambun dev
steambun build
steambun preview
```

Config is optional. With no config file, `dev`, `build`, and `preview` use the defaults below.

## Commands

| Command | Action |
| --- | --- |
| `steambun` / `steambun dev` | Dev server (default) |
| `steambun build` | Production build to `build.outDir` (default `dist`) |
| `steambun preview` | Serve the last production build |
| `steambun analyze` | Report outputs (with gzip/zstd/brotli columns), packages, and duplicates from the last build's metafile. `--compare`, `--ci`, `--md`, `--html` add a baseline diff, CI annotations, a Markdown report, and a treemap |
| `steambun routes` | Print the route graph (HTML, `publicDir`, `api`, `proxy`) without starting a server |
| `steambun migrate` | Convert a `vite.config.*` into `steambun.config.ts` (never overwrites an existing one) |
| `steambun doctor` | Check config conflicts, `.steambun/` tsconfig reachability, and secret-shaped public env keys; exits 1 on any failure |

| Flag | Meaning |
| --- | --- |
| `--port <n>` | Port for `dev` and `preview` |
| `--host [addr]` | Bind address. Omit the value, or set `server.host: true`, to bind `0.0.0.0` |
| `--strictPort` | Fail instead of trying the next port (`dev`, `preview`) |
| `--open` | Open a browser after listen (`dev`, `preview`) |
| `--emptyOutDir <true\|false>` | Override `build.emptyOutDir` (`build`) |
| `--logLevel <silent\|error\|warn\|info>` | Set log verbosity. Default `info` |
| `--mode <name>` | Mode. Default `development` for `dev`, `production` for `build` |
| `--config <path>` | Config file (skips discovery) |
| `--root <path>` | Project root (default: cwd) |
| `--json` | Machine-readable output for `analyze`, `routes`, and `doctor` |
| `--why <text>` | `analyze` only: print up to 3 shortest import chains from an entry to a path containing `<text>` |
| `--compare <metafile.json>` | `analyze` only: diff outputs against a prior build's `.steambun/metafile.json` (added/removed/changed, largest delta first) |
| `--ci` | `analyze`: print `::error`/`::warning` GitHub Actions annotations for budget violations and (with `--compare`) outputs that grew over 10%. `doctor`: same annotations for failing/warning checks. Implied when `GITHUB_ACTIONS` is set |
| `--md` | `analyze` only: print the report as GitHub-flavored Markdown tables instead of aligned text |
| `--html [out]` | `analyze` only: write a self-contained treemap HTML report (default `<root>/analyze.html`) |
| `--brotli` | `analyze` only: also compute brotli sizes for the compression columns. Off by default — brotli is slow |

## Doctor

`steambun doctor` runs a fixed set of checks against the resolved config and project files:

| Check id | Catches |
| --- | --- |
| `bun-version` | Bun older than the required 1.4.0 |
| `html-entries` | No `*.html` entrypoints under `root` |
| `config-conflict` | A `steambun.config.*` and a `bunfig.toml` `[steambun]` table both exist — the TS config wins and the table is silently ignored |
| `stray-vite-config` | A `steambun.config.*` and a `vite.config.*` both exist — the Vite config is never read |
| `tsconfig-reachability` | `tsconfig.json`'s `include`/`exclude` would hide the generated `.steambun/env.d.ts` / `.steambun/routes.d.ts` from the editor or `tsc` |
| `tsconfig-types` | `compilerOptions.types` is set but omits both `"bun-types"` and `"@types/bun"` |
| `gitignore` | `.gitignore` doesn't cover `.steambun` or `build.outDir` |
| `secret-env-keys` | A public env key (matching `envPrefix`) looks like a secret (`SECRET`, `TOKEN`, `PASSWORD`, `PRIVATE`, `API_KEY`) and would be inlined into client JavaScript |
| `env-in-public-dir` | A `.env*` file sitting inside `publicDir`, publicly reachable |
| `outdir-placement` | `build.outDir` resolving to `root` itself, or inside `publicDir` |

Each check is `"ok"`, `"warn"`, or `"fail"`; the command exits `1` if any check is `"fail"`. `--json` prints `{ checks, ok }` instead of the colored report, e.g.:

```json
{
  "checks": [{ "id": "bun-version", "level": "ok", "message": "Bun 1.4.2" }],
  "ok": true
}
```

`--ci` (or `GITHUB_ACTIONS=true`) additionally prints a `::error`/`::warning` GitHub Actions workflow command per failing/warning check, regardless of `--json`.

## HTML entries

Every `*.html` file under the project root is an entry, except files in `node_modules`, `.git`, `.steambun`, `dist`, and `public`.

| File | Route |
| --- | --- |
| `index.html` | `/`. Unmatched paths fall back to this file when `appType` is `"spa"` (default) |
| `about.html` | `/about` |
| `about/index.html` | `/about` |

File lookup runs first in both modes: `/about` serves `about.html`, `/about/` serves `about/index.html`. After a miss, `"spa"` serves `index.html` and `"mpa"` returns 404. `appType` applies to `dev`, `preview`, and `compile`.

In `dev` only, a thrown error in an API route, a `middleware` function, or `server.proxy`'s handler returns a visible `500` instead of a bare crash — JSON with `error`/`stack`/`method`/`path`/`route`, or an HTML alert dialog for a browser navigation (`Accept: text/html`). `preview`, `dist/server.js`, and a compiled binary keep the generic `500`.

## Configuration

Discovery order:

1. `steambun.config.ts` / `.mts` / `.js` / `.mjs`
2. `bunfig.toml`

`--config` overrides discovery. If both a TypeScript config and `bunfig.toml` exist, the TypeScript file is the steambun config. `steambun dev` still merges the project `bunfig.toml` into `.steambun/bunfig.toml` so Bun still sees `[install]`, `[define]`, `preload`, and `[serve.static]` plugins.

`steambun dev` restarts the whole dev server (not just `--hot`'s in-process reload) when the config file or `bunfig.toml` changes, an `.env*` file changes, or a `*.html` file is added or removed — debounced 100ms. `root` is watched recursively for `.html` add/remove at any depth; `envDir`'s `.env*` files are watched at their top level only; each restart logs which file triggered it; if the dev server crashes on its own it prints `dev server exited (code N) — waiting for a change to restart` and keeps watching instead of exiting; on Linux, a directory created after the dev server started may not be included in the recursive watch until the next restart (see oven-sh/bun#15939) — macOS and Windows don't have this gap.

Functions cannot live in TOML: middleware factories, plugin `setup`, `defineConfig(({ mode }) => ...)`, and `proxy.rewrite`. Those require a TypeScript config.

### TypeScript

```ts
import { defineConfig } from "steambun";

export default defineConfig(({ mode }) => ({
  publicDir: "public",
  server: {
    port: 5173,
    proxy: { "/api-legacy": "http://localhost:8080" },
  },
  resolve: { alias: { "@": "./src" } },
  build: { outDir: "dist", manifest: true, standalone: false },
  api: "./src/api",
  middleware: [],
  compile: false,
}));
```

### bunfig.toml

Native Bun keys apply as steambun config: `[serve] port`, `[define]`, `[serve.static]`. All other steambun keys go under `[steambun]`, including the full `build` option set (`sri`, `csp`, `budgets`, `precompress`, `sharedCss`, `importMap`, ...). Plugin and middleware values in TOML are module specifiers, not inline functions. Unknown or wrong-typed `[steambun.*]` keys print a `[steambun] Unknown bunfig key ...` (or `... expected X, got Y`) warning and are ignored, rather than failing silently.

```toml
[serve]
port = 5173

[define]
__APP_VERSION__ = "'1'"

[serve.static]
plugins = ["bun-plugin-tailwind"]
env = "PUBLIC_*"

[steambun]
api = "./src/api"
publicDir = "public"

[steambun.server]
host = true

[steambun.server.proxy]
"/api-legacy" = "http://localhost:8080"

[steambun.build]
outDir = "dist"
sri = true
precompress = ["gzip", "br"]

[steambun.resolve.alias]
"@" = "./src"
```

### Migrating from Vite

If no `steambun.config.ts` or `bunfig.toml` exists, steambun also discovers `vite.config.{ts,mts,js,mjs}` and loads it (calling it with `{ command, mode }` if it exports a function), converting a static allowlist of keys: `server.{port,host,open,cors,headers,proxy,https}`, `build.{outDir,assetsDir,sourcemap,minify,manifest,target}`, `preview.{port,host,open,strictPort}`, `resolve.{alias,extensions}` (alias as array or object form), `define`, `envPrefix`, `envDir`, `base`, `publicDir`, `appType` (`"spa"`/`"mpa"` only), and `plugins` (always warned — Vite plugins can't run under Bun's bundler). Every other key prints one `[steambun] Vite config key "..." is not supported and was ignored.` warning.

`steambun migrate` writes the converted config to `steambun.config.ts` once, so you're not running against a re-parsed `vite.config.*` on every command — it never overwrites an existing steambun config. Functions in the Vite config (`proxy.rewrite`, etc.) are inlined verbatim and listed in a header comment for review; ignored keys are listed in the same header. A function-form Vite config is evaluated for both dev and build, and the production result is written when they differ.

`resolve.viteSuffixes: true` shims Vite's `?raw` / `?url` / `?inline` import suffixes (`import txt from "./file.txt?raw"`) as a Bun plugin, in both `dev` and `build`.

## Server and build

| Key | Default | Behavior |
| --- | --- | --- |
| `appType` | `"spa"` | `"spa"` or `"mpa"`. After file lookup, unmatched paths get `index.html` (`spa`) or 404 (`mpa`). Applies to `dev`, `preview`, and `compile` |
| `server.port` | `5173` | Listen port. `PORT`, `HOST`, and `STRICT_PORT` env vars override `server.port`/`server.host`/`server.strictPort` for `steambun dev`, the same way they do for `steambun preview` and `dist/server.js` |
| `server.host` | `false` (`127.0.0.1`) | `true` binds `0.0.0.0` |
| `server.open` | off | Open a browser after listen. `true` opens `/`. A string is a path. If no browser opener is available, a warning is printed and startup continues. Binding `0.0.0.0` prints one `Local:` and one `Network:` line per non-internal IPv4 interface instead of a single ready line |
| `server.cors` | `false` | CORS middleware |
| `server.headers` | | Extra response headers |
| `server.https` | | `{ key, cert, ca?, passphrase? }` paths, resolved against `root`. Maps to `Bun.serve({ tls })` |
| `server.idleTimeout` | Bun default (10s) | Seconds of inactivity before Bun closes the connection. `text/event-stream` responses are exempted automatically — see [Server-Sent Events](#server-sent-events) |
| `server.maxRequestBodySize` | Bun default (128MB) | Max request body in bytes |
| `server.strictPort` | `false` | When `port` is taken, `dev` and `preview` try the next port (up to 10) and print a notice; `true` fails instead. `dist/server.js` always fails on a taken port |
| `preview.port` / `host` / `open` | port `4173` | Same shapes as `server.*` |
| `preview.strictPort` | `false` | Same as `server.strictPort`, for `steambun preview` |
| `base` | `"/"` | `import.meta.env.BASE_URL` and Bun `publicPath` |
| `resolve.alias` | | Bun `onResolve` plugin in `dev` and `build` |
| `resolve.viteSuffixes` | `false` | Shims Vite's `?raw` / `?url` / `?inline` import suffixes as a Bun plugin, in `dev` and `build` |
| `build.outDir` | `"dist"` | Build output directory |
| `build.emptyOutDir` | `true` | Emptied before each build when inside `root`; a directory outside `root` is never emptied |
| `build.assetsDir` | `"assets"` | Asset subdirectory |
| `build.sourcemap` | `false` | `true` / `"inline"` / `"external"` |
| `build.minify` | `true` | `boolean`, `{ whitespace, syntax, identifiers, keepNames }`, or `"esbuild"` / `"terser"` (both use Bun's minifier) |
| `build.drop` | `["debugger"]` in production | Identifiers to drop |
| `build.manifest` | `false` | Write `manifest.json` |
| `build.target` | `"browser"` for HTML | `"browser"` / `"bun"` / `"node"` |
| `build.bytecode` | off | Only applied when `compile: true` |
| `build.splitting` | off | `Bun.build({ splitting })`. Shared modules and `import()` become hashed chunks under `assetsDir`. Ignored for `standalone` and `compile` |
| `build.cssChunking` | off | `Bun.build({ cssChunking })`. Bun 1.4.1 applies this to JS entrypoints only; for HTML entrypoints use `build.sharedCss` |
| `build.minChunkSize` | | `Bun.build({ minChunkSize })`. Requires `build.splitting` |
| `build.importMap` | `false` | Rewrites chunk-to-chunk imports through a `<script type="importmap">` keyed by content-independent ids, so a shared-module change only re-hashes that one chunk instead of cascading through every importer. Requires `build.splitting`; ignored (with a warning) without it, and for `build.standalone`. Needs import map support in the browser (Chrome 89+, Safari 16.4+, Firefox 108+). `steambun preview` and `dist/server.js` answer the dynamic-import preload helper's `/@chunk/<id>.js` requests (which import maps don't cover) with a redirect to the current file |
| `build.sharedCss` | `false` | Extracts stylesheets used by two or more pages into `assetsDir/shared-<hash>.css` files, so a shared-CSS change only invalidates that file instead of every page's stylesheet. `{ minSize }` (default `2048`, minified bytes) is the minimum combined size worth extracting. A page whose shared block isn't a clean prefix/suffix of its own CSS (nothing in between) is left unmodified and logged as skipped. Ignored for `build.standalone` |
| `build.budgets` | | Glob → max size (`"250kb"`, `"1.5mb"`, or a byte count). `steambun build` fails when an output exceeds its budget (checked on raw, uncompressed size) |
| `build.precompress` | `false` | `false` or a subset of `["gzip", "br", "zstd"]`. Writes `.gz`/`.br`/`.zst` siblings for compressible files (JS, CSS, HTML, SVG, JSON, txt, map, XML, wasm) at least `precompressMinSize` bytes, skipping a variant that doesn't beat the original by 5% |
| `build.precompressMinSize` | `1024` | Minimum file size, in bytes, to precompress |
| `build.server` | `true` | Write `dist/server.js`, a bundled, dependency-free copy of the preview server. Run it with `bun dist/server.js`; `PORT` and `HOST` env vars work as in `steambun preview`. Skipped for `build.standalone` |
| `build.sri` | `false` | Adds `integrity`/`crossorigin="anonymous"` to every local `<script src>` and `<link rel="stylesheet" href>` (a `sha384` hash of the built file). Paths are resolved against `base` |
| `build.csp` | `false` | `"strict"` or a `{ directive: values[] }` object. Writes `dist/_headers.json` with a `Content-Security-Policy` for `"/**/*.html"` (every HTML page, at any depth), built from `sha256` hashes of every inline `<script>`/`<style>` merged into `script-src`/`style-src`. `"strict"` is `default-src 'self'; script-src 'self' <hashes>; style-src 'self' <hashes>; object-src 'none'; base-uri 'self'`. Directives without sources are omitted; an object without `script-src`/`style-src` gets only the inline hashes for those directives |
| `build.headers` | none | Extra response headers by glob, matched the same way as `build.csp`'s `_headers.json` entries. Merged into `dist/_headers.json`; for a glob present in both, this wins per header key over the CSP-generated entry |
| `build.deploy` | `false` | `"netlify"` / `"cloudflare-pages"` write `dist/_headers` + `dist/_redirects`; `"vercel"` writes `dist/vercel.json`; `"static"` writes `dist/_headers` + `dist/_redirects` (the most portable pair). `dist/_headers.json` is always written regardless of this setting — see [Deploying](#deploying) |
| `features` | | Bun `--feature` flags for `bun:bundle` dead-code elimination (`import { feature } from "bun:bundle"`). Merges with the `STEAMBUN_FEATURES` env var (comma-separated). In `dev`, only the env var applies — Bun's dev bundler has no `features` build option in 1.4.1 |

After JS/CSS minify, steambun collapses tag whitespace in the HTML output.

`steambun build` writes `.steambun/metafile.json` (Bun's build metafile) so `steambun analyze` can report on it after the fact, without a full rebuild. Sizes reflect the files as written after `build.importMap`/`build.sharedCss` rewrote and renamed them; `build.budgets` is checked against those final, on-disk sizes. A "duplicate package" is one resolved to more than one distinct *version* across `node_modules/<name>` directories — same-version copies hoisted into separate directories (as some pnpm layouts do) aren't flagged.

The terminal summary printed after every build shows a `gzip:` size (level 9, never brotli — too slow to run on every build) next to each compressible output of at least 1KB (the same extension list `build.precompress` uses), plus a total row for both raw and gzip size. When `build.precompress` already wrote a `.gz` sibling, the summary reports that file's size instead of compressing again.

Under `GITHUB_ACTIONS=true` or `STEAMBUN_CI=1`, a size-budget violation and a `build.outDir`-outside-`root` warning also print a `::error`/`::warning` GitHub Actions workflow command, so they're inlined on a PR's Files Changed view instead of only the raw log.

`steambun preview` and `dist/server.js` serve assets under `assetsDir` with `Cache-Control: public, max-age=31536000, immutable` (they're content-hashed) and everything else with a weak `ETag` and `Cache-Control: no-cache` (304 on a matching `If-None-Match`); HTML always gets `no-cache`. When `build.precompress` produced a `.gz`/`.br`/`.zst` sibling, a matching `Accept-Encoding` serves it with `Content-Encoding` set and the original file's `Content-Type`. When `build.csp` wrote `_headers.json`, both also apply its headers to any response whose resolved file path matches one of its globs, so the CSP header applies to every HTML file at any depth. With `build.importMap`, a shared-module change invalidates only that chunk instead of every page that imports it. `_headers.json` and `.steambun-chunks.json` are server-side build inputs and are never served; `manifest.json` is (it's a documented artifact). Request paths are percent-decoded before resolving (a malformed encoding is a `400`; a decoded `..` segment or a NUL byte is a `404`). `HEAD` reports the same `Content-Length` a `GET` would.

## publicDir

Default `"public"`. Files are not bundled. `public/favicon.ico` is served at `/favicon.ico`.

- `dev`: each file is an exact `Bun.serve` route
- `build`: the directory is copied into `outDir`
- HTML under `public/` is not an app entry
- A missing directory is ignored
- `false` disables it
- Dotfiles (`.DS_Store`, `.gitkeep`, `.env*`, ...) are never served
- A `.html` or `.env*` file inside `publicDir` prints a `[steambun]` warning at startup (`.html` is still routed as a plain static file; `.env*` is not served at all)
- Filenames with spaces or non-ASCII characters are served correctly

## Environment

Files, later overriding earlier: `.env`, `.env.local`, `.env.[mode]`, `.env.[mode].local`. `process.env` wins.

`envPrefix` defaults to `["VITE_", "PUBLIC_"]`. Matching keys are available as `import.meta.env.*` and inlined as `process.env.PREFIX_*`. `define` applies in `dev` and `build`.

Both modes are token-aware, so a `define` key can't corrupt a string literal, a comment, or an unrelated longer identifier. `build` uses `Bun.build({ define })` directly. `dev` has no equivalent — Bun's dev bundler exposes no JS-level `define` hook — so substitution runs through a generated boundary- and comment/string-aware scanner instead.

Builtins: `MODE`, `DEV`, `PROD`, `BASE_URL`, `SSR`. `dev` and `build` write `.steambun/env.d.ts` from public keys. Reference the builtins with:

```ts
/// <reference types="steambun/client" />
```

## API routes

Set `api` to a directory (for example `"./src/api"`). Each file becomes a `Bun.serve` route.

- Named exports `GET`, `POST`, and the other HTTP methods, or a default export for every method
- `[id].ts` → `/api/:id` (`req.params.id`)
- `[...slug].ts` → `*` wildcard
- `[[...slug]].ts` → the parent path and a wildcard

Files load in sorted order. When two files map to the same path, the more specific one wins
(`index.ts` over `[[...slug]].ts`, a literal segment over `:param` over `*`), and ties go to the
lexically-first file. Every collision is printed by `dev`, `preview` (and the compiled binary), and
`steambun routes`.

Frontend HMR and `bun --hot` reload API modules together.

### WebSocket routes

Export `websocket` alongside (or instead of) the HTTP methods and the route becomes a WebSocket endpoint too:

```ts
// src/api/chat/[room].ts
export const websocket = {
  open(ws) { ws.subscribe(ws.data.params.room); },
  message(ws, msg) { ws.publish(ws.data.params.room, msg); },
  close(ws) {},
};
export const GET = (req) => Response.json({ room: req.params.room }); // optional
```

`ws.data.params` carries the route's `:param` values, same as `req.params`. Middleware still runs first — a middleware `Response` (401, etc.) blocks the upgrade. A request without an `Upgrade` header falls through to `GET` if present, else `426`. Bun allows exactly one server-level `websocket` handler; steambun merges file-based WebSocket routes and `server.proxy`'s `ws: true` connections into it automatically.

```ts
import { ws } from "steambun/client";

const chat = ws("/api/chat/:room", { params: { room: "42" }, reconnect: true });
chat.on("message", (ev) => console.log((ev as MessageEvent).data));
chat.send("hello");
```

`ws(path, { params?, query?, protocols?, reconnect? })` mirrors `api()`/`href()` — `path` is checked against routes exporting `websocket`; `reconnect: true` (or `{ maxAttempts?, baseDelayMs? }`) retries with capped exponential backoff, and the returned `close()` never reconnects.

### Server-Sent Events

A response with `Content-Type: text/event-stream` automatically gets `server.timeout(req, 0)` so Bun's idle timeout doesn't cut the stream — no manual call needed.

### Typed API client

`dev` and `build` (and `steambun routes`) write `.steambun/routes.d.ts`: every API route path with its `:param` names and a `typeof import(...)` reference to its module, plus every page path. It augments ambient types in `"steambun/client"` — no manual wiring needed, just make sure `.steambun/` is reachable by `tsc` (it is by default).

Wrap a handler in `route()` (from `"steambun/runtime"`) so its return value becomes `Response.json(...)` and its real type flows through to the client:

```ts
// src/api/users/[id].ts
import { route } from "steambun/runtime";

export const GET = route(({ params }) => ({ id: params.id }));
```

```ts
// anywhere on the client
import { api, href } from "steambun/client";

const user = await api("get", "/api/users/:id", { params: { id: "42" } });
//    ^? { id: string } — inferred from the route() handler above

const link = href("/api/users/:id", { id: "42" }); // "/api/users/42"
```

`href(path, params?, query?)` also takes an optional third `query` argument, appended as a query string (e.g. `href("/about", undefined, { tab: "info" })` → `"/about?tab=info"`).

`api(method, path, { params?, query?, body?, init? })` substitutes `:param` segments, JSON-encodes `body` (without overriding a caller-set `content-type`), prefixes `import.meta.env.BASE_URL`, and throws a `SteambunApiError` (`status`, `body`, and a message that includes the method and path) on a non-2xx response. On success, a `204`/`205` or empty body resolves `undefined`, a non-JSON response resolves raw text, and anything else resolves parsed JSON. Without `route()`, a handler returning a bare `Response` types as `unknown` — parse it yourself.

`route()` imports from `"steambun/runtime"`, which a `compile: true` binary can't resolve inside an api route file — `--compile` dynamically imports api routes from its embedded assets, which can only reach Bun/Node builtins. Keep compiled-binary api routes on bare handlers.

## Middleware

`middleware: [auth()]` is `(req, next) => Response`. It wraps API routes and proxy entries. In `bunfig.toml`, use specifiers: `middleware = ["./src/auth.ts"]`.

## Proxy

`server.proxy` maps a path prefix to a target string or `{ target, changeOrigin?, rewrite?, ws? }`. `ws: true` proxies WebSockets.

An unreachable target (connection refused, DNS failure) returns `502` with `{ error: "proxy target unreachable", target }` instead of an unhandled rejection. `changeOrigin: true` also sets `X-Forwarded-Proto`, `X-Forwarded-Host`, and `X-Forwarded-For`, without overwriting a value the incoming request already carries. Hop-by-hop headers (`Connection`, `Keep-Alive`, `Proxy-Authenticate`, `Proxy-Authorization`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`) are stripped from both the outgoing request and the returned response.

## Plugins and macros

Bun `onResolve` / `onLoad` plugins in `plugins` run in `dev` and `build`. Macros (`import { foo } from "./foo.ts" with { type: "macro" }`) run at bundle time. There is no steambun config key for macros.

A `plugins` entry with no `setup` is instead treated as a **steambun hooks** object — a plain `{ name?, ...hooks }` for participating in steambun's own lifecycle rather than Bun's bundler:

| Hook | When | Signature |
| --- | --- | --- |
| `configResolved` | End of `loadConfig`, once per hook plugin | `(config: ResolvedConfig) => void \| Promise<void>` |
| `configureApp` | End of `createApp`, before `serveOptions` is built | `(app: App, ctx: { mode: "dev" \| "preview" }) => void \| Promise<void>` |
| `buildStart` | Before `Bun.build()` for the HTML entries | `(ctx: { config: ResolvedConfig; entrypoints: string[] }) => void \| Promise<void>` |
| `transformHtml` | After the build, per output HTML file | `(html: string, ctx: { path: string }) => string \| Promise<string>` |
| `onBuildEnd` | After outputs are written | `(artifacts: unknown) => void \| Promise<void>` |
| `closeBundle` | End of `build()`, after `--compile` if enabled | `(ctx: { outDir: string }) => void \| Promise<void>` |

A plugin object matching neither a Bun plugin (`setup`) nor any hook key throws `[steambun] Unrecognized plugin at index N` — catches a typo'd hook name instead of silently no-op'ing.

## Programmatic API

`dev`, `build`, and `preview` are exported from `"steambun"` alongside `defineConfig` and `loadConfig`, for tooling that wants to drive steambun without the CLI.

`createApp({ config, mode, htmlRoutes?, outDir?, apiDir? })`, exported from `"steambun/runtime"`, builds the same route table `dev` and `preview` serve from: HTML entries, `publicDir`, `server.proxy`, `api`, and (in `"preview"` mode) the static asset and SPA-fallback routes. It returns `{ routes, middleware, serveOptions, fetch, close, routeTable }` — pass `serveOptions` to `Bun.serve` alongside `port`/`hostname`/`tls`, call `fetch(req)` to dispatch a request through a real, lazily started `Bun.serve` instance bound to those routes (handy in tests — call `close()` afterward to stop it), or call `routeTable()` to inspect the rows directly (not printed automatically).

## Compile

Two different Bun compile modes:

| Key | Bun equivalent | Output |
| --- | --- | --- |
| `build.standalone: true` | `--compile --target=browser` | One `.html` per entry, with JS, CSS, and relative assets inlined |
| `compile: true` | `--compile` | A single binary. Steambun embeds static assets, API routes, proxy, and middleware |

`compile` also accepts an options object instead of `true`:

| Key | Default | Behavior |
| --- | --- | --- |
| `compile.targets` | host only | Cross-compile targets, e.g. `["bun-linux-x64", "bun-darwin-arm64"]`. One binary per target, named `bin/server-<target>` (`.exe` for `bun-windows-*`). Downloads the target's runtime; not exercised in CI |
| `compile.outDir` | `"bin"` | Output directory for compiled binaries |
| `compile.windows` | | `{ icon?, hideConsole?, title?, publisher?, version?, description?, copyright? }` |
| `compile.autoloadDotenv` | `false` | Whether the binary loads `.env` files at runtime. Bun defaults this `true`; steambun defaults it `false` — a compiled server should get its config from real env vars, not files that may not ship with the binary |
| `compile.autoloadBunfig` | `true` (Bun's default) | Whether the binary loads `bunfig.toml` at runtime |

```toml
[steambun.compile]
targets = ["bun-linux-x64", "bun-darwin-arm64"]
outDir = "bin"

[steambun.compile.windows]
title = "My App"
```

## Deploying

The first recipe needs only `dist/`:

```dockerfile
# dist/server.js — any host that runs a container
FROM oven/bun:1-slim
WORKDIR /app
COPY dist ./dist
CMD ["bun", "dist/server.js"]
```

The second embeds the Bun runtime in the binary, so `scratch` (no glibc, no shell) is enough — `PORT`/`HOST` work the same in both:

```dockerfile
# compile: { targets: ["bun-linux-x64-musl"] } — no Bun runtime install needed
FROM scratch
COPY bin/server-bun-linux-x64-musl /server
CMD ["/server"]
```

## Examples

All use `bun run dev` / `build` / `preview`.

| Directory | What it shows |
| --- | --- |
| [`examples/minimal`](examples/minimal) | `index.html` and `steambun.config.ts` |
| [`examples/bunfig`](examples/bunfig) | `bunfig.toml` only, `build.splitting` |
| [`examples/zero-config`](examples/zero-config) | Same app, no config file |
| [`examples/standalone`](examples/standalone) | `build.standalone: true` |
| [`examples/multi-page`](examples/multi-page) | Three pages sharing a JS chunk and a stylesheet, `build.splitting`/`build.importMap`/`build.sharedCss` |
| [`examples/fullstack`](examples/fullstack) | API routes (`[id]`), a `steambun/client` fetch against the generated route types, a file-based WebSocket chat route, middleware, WebSocket proxy, `.env`, a macro, a second HTML entry, Bun plugins, a `SteambunHooks` plugin, `build.sri`/`build.csp`, `build.splitting`/`build.importMap`, `compile: true` |
| [examples/testing](examples/testing) | `createApp({ mode: "preview" }).fetch()` inside `bun test` — no browser needed |

## Development

Single package at the repo root (`src/`, `bin/`); `examples/*` are workspace members depending on `steambun: file:../..` (Bun's `workspace:*` only resolves siblings under the `workspaces` glob, not the root package itself).

```bash
bun install
bun run typecheck   # tsc --noEmit across the workspace
bun run lint        # biome check
bun run test        # bun test
```

`file:` installs copy the package into `node_modules/.bun`'s store rather than symlinking it live. Re-run `bun install` after editing `src/` to see the change from an example.

### Scope

Steambun is a thin layer over Bun's fullstack server, not a parallel toolchain. New features must fill a gap Bun leaves (see [When you don't need steambun](#when-you-dont-need-steambun)); build-time extras beyond Vite parity are not being expanded.

When a Bun release ships a native equivalent, delete the steambun version and pass the config through to Bun. Current workarounds to re-check on each Bun upgrade:

| Workaround | Bun gap | Where |
| --- | --- | --- |
| Dev-mode `define`/env scanner | Dev bundler has no JS-level `define` | `src/dev/env-plugin.ts` |
| `features` only from `STEAMBUN_FEATURES` in dev | Dev bundler has no `features` option | `src/dev/dev.ts` |
| `build.sharedCss` | `cssChunking` ignores HTML entrypoints | `src/build/shared-css.ts` |
| Middleware wraps only API and proxy routes | Native HTML/asset routes can't be wrapped (oven-sh/bun#17608) | `src/runtime/middleware.ts` |
| File-based API routes | No route auto-discovery | `src/runtime/api-routes.ts` |
