# steambun

Steambun is Bun's fullstack dev server plus Vite-style config. `steambun dev` starts `Bun.serve` with HMR. `steambun build` runs `Bun.build`. Both use Bun's bundler; steambun adds only what Bun does not:

- One config file that drives `dev`, `build`, `preview`, and `compile`
- Env checked against a Standard Schema (zod, valibot, arktype, ...) at dev, build, and server startup, with typed `import.meta.env`
- Vite parity: `server.proxy` (HTTP and WebSocket), `publicDir`, `.env.[mode]` files, `import.meta.env.MODE`/`DEV`/`PROD`/`BASE_URL`, `import.meta.glob`, `base`, `resolve.alias`, `?raw`/`?url`/`?inline`, and `steambun migrate` from a `vite.config.*`
- File-based API and WebSocket routes, middleware, schema-validated `route()` handlers, and a typed `api()` client, served in the same process as the frontend, with a build-time guard that keeps server modules out of client bundles
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

Requires Bun >= 1.4.4 and at least one `*.html` file (usually `index.html` at the project root).

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
| `steambun analyze` | Report outputs (with gzip/zstd columns), packages, and duplicates from the last build's metafile. `--compare` and `--html` add a baseline diff and a treemap; the text report exits 1 when an output exceeds `build.budgets` |
| `steambun routes` | Print the route graph (HTML, `publicDir`, `api`, `proxy`) without starting a server |
| `steambun migrate` | Convert a `vite.config.*` into `steambun.config.ts` (never overwrites an existing one) |
| `steambun doctor` | Run the project checks listed under [Doctor](#doctor); exits 1 on any failure |

| Flag | Meaning |
| --- | --- |
| `--port <n>` | Port (1-65535) for `dev` and `preview` |
| `--host [addr]` | Bind address. Omit the value, or set `server.host: true`, to bind `0.0.0.0` |
| `--strictPort` | Fail instead of trying the next port (`dev`, `preview`) |
| `--open` | Open a browser after listen (`dev`, `preview`). `--no-open` overrides `server.open: true` |
| `--emptyOutDir` | Override `build.emptyOutDir` (`build`); `--no-emptyOutDir` turns it off |
| `--logLevel <silent\|error\|warn\|info>` | Verbosity of steambun's own CLI output (not the running dev/preview server's). Default `info` |
| `--mode <name>` | Mode. Default `production` for `build`, `preview`, and `analyze`; `development` for `dev`, `routes`, and `doctor`. `dev` runs the server with `NODE_ENV=production` only for `--mode production`, otherwise `development` |
| `--config <path>` | Config file (skips discovery); not accepted by `migrate` |
| `--root <path>` | Project root (default: cwd) |
| `--json` | Machine-readable output for `analyze`, `routes`, and `doctor` |
| `--why <text>` | `analyze` only: print up to 3 shortest import chains from an entry to a path containing `<text>` |
| `--compare <metafile.json>` | `analyze` only: diff outputs against a prior build's `.steambun/metafile.json` (added/removed/changed, largest delta first) |
| `--html [out]` | `analyze` only: write a self-contained treemap HTML report (default `<root>/analyze.html`; an explicit path resolves against the current directory) |
| `--brotli` | `analyze` only: add a brotli column to the compression sizes. Off by default — brotli is slow |

A flag that doesn't apply to the invoked command is an error (for example `--port` on `build`), exit 1; `--root` and `--logLevel` apply everywhere, and `--config` and `--mode` to every command except `migrate`. Flags may come before or after the command (`steambun --root app build`). In `analyze`, `--json` can't be combined with `--html`, `--why`, or `--brotli` (it does work with `--compare`), and `--why` can't be combined with `--html`, `--compare`, or `--brotli`. `analyze --json` and `--why` never check budgets or set the exit code. Unexpected (non-`[steambun]`) errors print only their message; set `STEAMBUN_DEBUG=1` to print the stack.

## Doctor

`steambun doctor` runs a fixed set of checks against the resolved config and project files:

| Check id | Catches | Fails as |
| --- | --- | --- |
| `config-load` | The config can't be loaded or fails [validation](#configuration); no other check runs | `fail` |
| `bun-version` | Bun older than the required 1.4.4 | `fail` |
| `html-entries` | No `*.html` entrypoints under `root` | `fail` |
| `config-conflict` | A `steambun.config.*` and a `bunfig.toml` `[steambun]` table both exist — the TS config wins and the table is silently ignored | `warn` |
| `stray-vite-config` | A `vite.config.*` exists next to a `steambun.config.*` or a `bunfig.toml` — the Vite config is never read | `warn` |
| `tsconfig-reachability` | `tsconfig.json`'s `include`/`exclude` would hide the generated `.steambun/env.d.ts` / `.steambun/routes.d.ts` from the editor or `tsc` (an unparseable `tsconfig.json` is a `warn`) | `fail` |
| `gitignore` | `.gitignore` is missing or doesn't cover `.steambun` or `build.outDir` | `warn` |
| `secret-env-keys` | A key in the `.env*` files matching `envPrefix` looks like a secret (`SECRET`, `TOKEN`, `PASSWORD`, `PRIVATE`, `API_KEY`) and would be inlined into client JavaScript | `fail` |
| `env-schema` | The merged env for the selected `--mode` (default `development`) fails `envSchema` (one failure per key) | `fail` |

A passing check is `"ok"`; the command exits `1` if any check is `"fail"`. `--json` prints `{ checks, ok }` instead of the colored report, e.g.:

```json
{
  "checks": [{ "id": "bun-version", "level": "ok", "message": "Bun 1.4.4" }],
  "ok": true
}
```

## HTML entries

Every `*.html` file under the project root is an entry, except files in dot-directories (`.git`, `.steambun`, ...), `node_modules`, `dist`, `public`, `build.outDir`, and `publicDir`.

| File | Route |
| --- | --- |
| `index.html` | `/`. Unmatched paths fall back to this file when `appType` is `"spa"` (default) |
| `about.html` | `/about` |
| `about/index.html` | `/about` |

Files are matched first: `/about` serves `about.html` or `about/index.html`. `dev` routes exact paths only, so `/about/` is a miss; `preview`, `dist/server.js`, and a compiled binary also accept a trailing slash. After a miss, `"spa"` serves `index.html` and `"mpa"` returns 404. `appType` applies to `dev`, `preview`, `dist/server.js`, and `compile`.

In `dev` only, an error thrown by an API route or `server.proxy`'s handler returns a `500` with `{ "error": <the error's message>, "stack", "method", "path", "route" }` (one thrown by a `middleware` function gets Bun's own HTML error page). `preview`, `dist/server.js`, and a compiled binary return the generic `{ "error": "Internal Server Error" }`.

## Configuration

Discovery order:

1. `steambun.config.ts` / `.mts` / `.js` / `.mjs`
2. `bunfig.toml`
3. `vite.config.ts` / `.mts` / `.js` / `.mjs` (only when neither of the above exists; see [Migrating from Vite](#migrating-from-vite))

`--config` overrides discovery; a `.toml` path is read as a bunfig and a `vite.config.*` path is converted like a discovered one. If both a TypeScript config and `bunfig.toml` exist, the TypeScript file is the steambun config and the `[steambun]` table is ignored. Whatever the config kind, `dev` merges the project `bunfig.toml` (or the `--config` one) into `.steambun/bunfig.toml` for Bun itself (`[install]`, `preload`, `[serve.static]`, ...), and `dev` and `build` load its `[serve.static] plugins` alongside `plugins`.

Config is validated when loaded; an invalid value throws a `[steambun] ...` error:

- `server.port` is an integer 0-65535; `server.maxRequestBodySize` a positive integer; `server.allowedHosts` is `true` or an array of non-empty strings
- each `envPrefix` entry is a non-empty string; `appType` is `"spa"` or `"mpa"`
- each `build.budgets` size is parseable
- `build.outDir` is neither the project root, nor inside `publicDir`, nor an ancestor of `publicDir` or `api`
- each `plugins` entry is a Bun plugin or a hooks object

`publicDir`, `envDir`, and `api` may be absolute.

`steambun dev` restarts the whole dev server (not just `--hot`'s in-process reload), debounced 100ms and logging the file that triggered it, when:

- the config file or `bunfig.toml` at `root` changes
- an `.env` / `.env.*` file at the top level of `envDir` changes
- a `*.html` file is added or removed at any depth under `root`, except under dot-directories, `node_modules`, `dist`, `public`, `build.outDir`, and `publicDir`

If the dev server crashes on its own, it prints `dev server exited (code N) — waiting for a change to restart` and keeps watching instead of exiting. A restart that fails to start (config error, missing `index.html`, env validation error) prints the error and waits the same way; only the very first start exits on failure. On Linux, a directory created after the dev server started may be missing from the recursive watch until the next restart (oven-sh/bun#15939).

Functions cannot live in TOML: middleware factories, plugin `setup`, `defineConfig(({ mode }) => ...)`, and `proxy.rewrite`. Those require a TypeScript config.

A config function receives Vite's `ConfigEnv`: `{ command: "serve" | "build", mode, isPreview }`. `dev` is `"serve"`; `preview` is `"serve"` with `isPreview: true`; `build` is `"build"`.

### TypeScript

```ts
import { defineConfig } from "steambun";

export default defineConfig({
  publicDir: "public",
  server: {
    port: 5173,
    proxy: { "/api-legacy": "http://localhost:8080" },
  },
  resolve: { alias: { "@": "./src" } },
  build: { outDir: "dist", manifest: true },
  api: "./src/api",
});
```

### bunfig.toml

Three native Bun keys also feed steambun config: `[serve] port` (`server.port`), `[define]` (`define`), and `[serve.static] env = "PUBLIC_*"` (`envPrefix`). A `[steambun]` value wins over the native key. All other steambun keys go under `[steambun]`, including the full `build` option set (`budgets`, `precompress`, `splitting`, ...). `middleware` in TOML is a list of module specifiers whose default export is the middleware function, and Bun plugins go in `[serve.static] plugins` (a hooks plugin needs a TypeScript config). Unknown or wrong-typed `[steambun.*]` keys print a `[steambun] Unknown bunfig key ...` (or `... expected X, got Y`) warning and are ignored, rather than failing silently.

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
precompress = ["gzip", "br"]

[steambun.resolve.alias]
"@" = "./src"
```

### Migrating from Vite

If no `steambun.config.ts` or `bunfig.toml` exists, steambun also discovers `vite.config.{ts,mts,js,mjs}` and loads it (calling it with the same `{ command, mode, isPreview }` if it exports a function), converting a static allowlist of keys: `server.{port,host,open,cors,headers,proxy,https,allowedHosts}` (`https` only as `{ key, cert }` file paths; `true` and inline PEM values are ignored; `allowedHosts: "all"` becomes `true`), `build.{outDir,assetsDir,sourcemap,minify,manifest,target}` (`minify: "esbuild"`, `"terser"`, and `"oxc"` become `true`; a `target` other than `"browser"`, `"bun"`, or `"node"`, such as `"esnext"`, is ignored), `resolve.alias` (array or object form; `resolve.extensions` is dropped silently), `define`, `envPrefix`, `envDir`, `base`, `publicDir`, `appType` (`"spa"`/`"mpa"` only), and `plugins` (always warned — Vite plugins can't run under Bun's bundler). `preview` is not converted: `steambun preview` uses `server.*`, so copy over any `preview.port` or `preview.host` you want. Every other key prints one `[steambun] Vite config key "..." is not supported and was ignored.` warning.

`steambun migrate` writes the converted config to `steambun.config.ts` once, so you're not running against a re-parsed `vite.config.*` on every command — it never overwrites an existing steambun config. Functions in the Vite config (`proxy.rewrite`, etc.) are inlined verbatim and listed in a header comment for review; ignored keys are listed in the same header. A function-form Vite config is evaluated for both dev and build, and the production result is written when they differ.

### `?raw`, `?url`, `?inline`

Vite's import suffixes (`import txt from "./file.txt?raw"`) work in `dev`, `build`, `dist/server.js`, and compiled binaries, through a built-in Bun plugin. `?raw` is the file's text, `?url` its hashed asset URL, and `?inline` a base64 `data:` URL. Aliases resolve (`@/file.txt?raw`).

### `import.meta.glob`

Vite's `import.meta.glob` works in client code with no config. Bun has no equivalent, so steambun expands each call at bundle time, in `dev` and `build`:

```ts
const pages = import.meta.glob("./pages/*.ts");
// { "./pages/about.ts": () => import("./pages/about.ts"), ... }

const icons = import.meta.glob<string>("@/icons/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});
// { "/src/icons/home.svg": "<hashed asset URL>", ... }
```

- Patterns start with `./`, `../`, `/` (the project root), or a `resolve.alias` key. An array mixes patterns and `!`-prefixed exclusions; a bare exclusion like `!**/*.test.ts` matches paths relative to the importing file. Extglobs (`!(a|b)`, `@(a|b)`, `+(a)`, ...) and brace ranges (`{1..3}`) work as in Vite; a `(` without a leading `!`, `@`, `+`, `?`, or `*` is literal, so `./(group)/*.ts` matches a directory named `(group)`.
- Keys are importer-relative for `./`/`../` patterns and root-relative (`/src/...`) for `/` and alias patterns, sorted.
- Options: `eager`, `import` (a named export, or `"*"`), and `query` (a string such as `"?raw"`). Any other option (`exhaustive`, `base`, `as`, `caseSensitive`, ...) is an error. Dotfiles and `node_modules` below the pattern's literal directory are skipped; symlinked directories are followed.
- Arguments must be literals. The importing file is never part of its own result.
- In `dev`, a newly added file that matches a glob appears the next time the importing file is re-bundled (edit it) or the dev server restarts.
- API routes and the compiled server aren't bundled through this transform, so `import.meta.glob` is client-only there.

`/// <reference types="steambun/client" />` types `import.meta.glob` along with `import.meta.env`.

## Server and build

| Key | Default | Behavior |
| --- | --- | --- |
| `appType` | `"spa"` | `"spa"` or `"mpa"`. After file lookup, unmatched paths get `index.html` (`spa`) or 404 (`mpa`), except unmatched `/api` paths when `api` is set (they always 404 as JSON). Applies to `dev`, `preview`, and `compile` |
| `server.port` | `5173` | Listen port for `dev`, `preview`, `dist/server.js`, and compiled binaries. `0` picks a free port from the config (the `--port` flag needs 1-65535) |
| `server.host` | `false` (`127.0.0.1`) | `true` binds `0.0.0.0` |
| `server.allowedHosts` | localhost and IP literals (`dev`, `preview`) | Extra hostnames allowed in `Host` (and a WebSocket's `Origin`), as an array of exact names or `.example.com` (that domain and its subdomains); `true` disables the check. `dist/server.js` and compiled binaries check only when this is set — see [Host and Origin checks](#host-and-origin-checks) |
| `server.open` | off | Open a browser after listen (`dev` and `preview`). `true` opens `/`. A string is a path. If no browser opener is available, a warning is printed and startup continues. Binding `0.0.0.0` prints one `Local:` and one `Network:` line per non-internal IPv4 interface instead of a single ready line |
| `server.cors` | `false` | Permissive CORS (`Access-Control-Allow-Origin: *`, preflights answered directly), applied like [`middleware`](#middleware) |
| `server.headers` | | Extra response headers, applied like [`middleware`](#middleware) |
| `server.https` | | `{ key, cert, ca?, passphrase? }` paths, resolved against `root`. Maps to `Bun.serve({ tls })` for `dev`, `preview`, `dist/server.js`, and compiled binaries — see [Local HTTPS](#local-https) |
| `server.idleTimeout` | Bun default (10s) | Seconds of inactivity before Bun closes the connection. `text/event-stream` responses are exempted automatically — see [Server-Sent Events](#server-sent-events) |
| `server.maxRequestBodySize` | Bun default (128MB) | Max request body in bytes |
| `server.strictPort` | `false` for `dev` and `preview`, `true` for `dist/server.js` and compiled binaries | When `port` is taken, a server with `strictPort` off tries the next port (up to 10) and prints a notice; on, it fails instead. Set it explicitly, or use `STRICT_PORT=0`/`1`, to override the default |
| `base` | `"/"` | `import.meta.env.BASE_URL` and Bun `publicPath` |
| `resolve.alias` | | Bun `onResolve` plugin in `dev` and `build` |
| `build.outDir` | `"dist"` | Build output directory |
| `build.emptyOutDir` | `true` | Emptied before each build when inside `root`; a directory outside `root` is never emptied |
| `build.assetsDir` | `"assets"` | Asset subdirectory |
| `build.sourcemap` | `false` | `true` / `"inline"` / `"external"` |
| `build.minify` | `true` | `boolean` or `{ whitespace, syntax, identifiers, keepNames }` |
| `build.drop` | `["debugger"]` when `--mode` is `production`, else `[]` | Identifiers to drop |
| `build.manifest` | `false` | Write `manifest.json`, keyed by each HTML entry's root-relative path (`file`, `src`, `isEntry`, `css`). Not available with `build.standalone` (warns) |
| `build.target` | `"browser"` for HTML | `"browser"` / `"bun"` / `"node"` |
| `build.splitting` | off | `Bun.build({ splitting })`. Shared modules and `import()` become hashed chunks under `assetsDir`. Ignored for `standalone` and `compile` |
| `build.budgets` | | Glob → max size (`"250kb"`, `"1.5mb"`, or a byte count). `steambun build` fails when an output exceeds its budget (checked on raw, uncompressed size, after the HTML pass). Not available with `build.standalone` (warns) |
| `build.precompress` | `false` | `false` or a subset of `["gzip", "br", "zstd"]`. Writes `.gz`/`.br`/`.zst` siblings for compressible files (JS, CSS, HTML, SVG, JSON, txt, map, XML, wasm) at least 1KB, skipping a variant that doesn't beat the original by 5% |
| `build.server` | `true` | Write `dist/server.js`, a bundled, dependency-free copy of the preview server. Run it with `bun dist/server.js`. Skipped for `build.standalone` |
| `build.features` | | Bun `--feature` flags for `bun:bundle` dead-code elimination (`import { feature } from "bun:bundle"`). Merges with the `STEAMBUN_FEATURES` env var (comma-separated). In `dev`, only the env var applies — Bun's dev bundler has no `features` option |

`PORT`, `HOST`, `STRICT_PORT`, and `OPEN` environment variables override `server.port`, `server.host`, `server.strictPort`, and `server.open` in `dev`, `preview`, `dist/server.js`, and compiled binaries. `--port`, `--host`, `--strictPort`, and `--open` reach `dev` and `preview` as these variables. An invalid `PORT` (not an integer 1-65535) or a `STRICT_PORT`/`OPEN` other than `1`/`true`/`0`/`false` is ignored with a warning; `HOST=` (empty) listens on all interfaces. `dev` and `preview` also read these from the `.env*` files; `dist/server.js` and compiled binaries read only the real environment.

After JS/CSS minify (`build.minify` `true` or `{ whitespace: true }`), steambun drops HTML comments other than IE conditional comments and collapses tag whitespace in the HTML output, keeping one space between adjacent inline elements. `<script>`, `<style>`, `<pre>`, and `<textarea>` bodies are untouched.

`steambun build` writes `.steambun/metafile.json` (Bun's build metafile) so `steambun analyze` can report on it after the fact, without a full rebuild. Sizes are the files as written to `outDir` (HTML is minified and `transformHtml`-rewritten after bundling); `build.budgets` is checked against those on-disk sizes. A "duplicate package" is one resolved to more than one distinct *version* across `node_modules/<name>` directories — same-version copies hoisted into separate directories (as some pnpm layouts do) aren't flagged.

The terminal summary printed after every build shows a `gzip:` size (level 9, never brotli — too slow to run on every build) next to each compressible output of at least 1KB (the same extension list `build.precompress` uses), plus a total row for both raw and gzip size. When `build.precompress` already wrote a `.gz` sibling, the summary reports that file's size instead of compressing again.

### Production server

`steambun preview`, `dist/server.js` (`build.server`), and the `compile` binary all run one server built by `createApp({ mode: "preview" })`: `api` routes, `server.proxy`, and a static handler for `outDir`. `dist/server.js` needs only Bun and the `dist/` directory (`bun dist/server.js`); a compiled binary needs nothing else. `PORT`/`HOST` apply as above, and `envSchema` is checked at startup (see [Env schema](#env-schema)).

The static handler serves assets under `assetsDir` with `Cache-Control: public, max-age=31536000, immutable` (they're content-hashed) and everything else with a weak `ETag` and `Cache-Control: no-cache` (304 on a matching `If-None-Match`); HTML always gets `no-cache`. When `build.precompress` produced a `.gz`/`.br`/`.zst` sibling, a matching `Accept-Encoding` serves it with `Content-Encoding` set and the original file's `Content-Type`. `manifest.json` is served (it's a documented artifact); the `dist/server.js` that `build.server` writes never is, since it embeds the config. Request paths are percent-decoded before resolving (a malformed encoding is a `400`; a decoded `..` segment or a NUL byte is a `404`). `HEAD` reports the same `Content-Length` a `GET` would. `dist/server.js` and compiled binaries resolve each path once and reuse it, since their output never changes; `steambun preview` looks files up on every request, so rebuilding while it runs serves the new output.

### Local HTTPS

Set `server.https` to `{ key, cert }` to serve `dev`, `preview`, `dist/server.js`, and a compiled binary over HTTPS, for APIs that need a secure context (service workers on a LAN address, WebAuthn, the clipboard). steambun doesn't issue certificates: generate one yourself, for example with [mkcert](https://github.com/FiloSottile/mkcert) (run `mkcert -install` once so browsers trust its local CA):

```sh
mkcert -key-file key.pem -cert-file cert.pem localhost 127.0.0.1 ::1
```

```ts
export default defineConfig({ server: { https: { key: "key.pem", cert: "cert.pem" } } });
```

`server.https: true` is an error in a TypeScript config, and is warned about and dropped from `bunfig.toml` and Vite configs.

### Host and Origin checks

A page on a hostile site can point its own domain at `127.0.0.1` (DNS rebinding) and then read your local dev server's API as if it were same-origin. To stop that, `dev` and `preview` answer `403` when the request's `Host` isn't allowed:

```json
{ "error": "Blocked request. Host \"evil.com\" is not allowed. To allow it, add it to server.allowedHosts." }
```

Allowed by default: `localhost`, any `*.localhost`, any IPv4 or IPv6 literal (`127.0.0.1`, `[::1]`, a LAN address; a literal can't be a rebinding target), and `server.host` when it's a hostname string. Add others to `server.allowedHosts`: `"app.test"` matches exactly, `".example.com"` matches `example.com` and every subdomain, and `true` turns the check off. The port is ignored.

```ts
export default defineConfig({ server: { host: true, allowedHosts: [".ngrok.app", "dev.box"] } });
```

A WebSocket upgrade (a file-based route or a `ws: true` proxy) is also rejected with `403` when it carries an `Origin` whose hostname isn't allowed, which stops a foreign page from opening a socket to your server. A same-origin page on an allowed host passes, and so does a client that sends no `Origin`.

`dist/server.js` and compiled binaries run behind whatever hostnames you deploy them on, so they check nothing unless you set `server.allowedHosts` to an array; the list then also admits localhost and IP literals.

The check covers what steambun's own handlers serve: API routes, WebSocket routes, `server.proxy`, and `preview`'s static files. In `dev`, HTML pages and `publicDir` files are Bun's native routes, which steambun can't wrap (oven-sh/bun#17608), so they are served for any `Host`; the API behind them is what the check protects.

## publicDir

Default `"public"`. Files are not bundled. `public/favicon.ico` is served at `/favicon.ico`.

- `dev`: each file is an exact `Bun.serve` route
- `build`: the directory is copied into `outDir`, skipping dotfiles and dot-directories
- HTML under `public/` is not an app entry
- A missing directory is ignored
- `false` disables it
- Dotfiles (`.DS_Store`, `.gitkeep`, `.env*`, ...) are never served
- A `.html` or `.env*` file inside `publicDir` makes `dev` print a `[steambun]` warning (`.html` is still routed as a plain static file; `.env*` is not served at all)
- Filenames with spaces or non-ASCII characters are served correctly

## Environment

Files, later overriding earlier: `.env`, `.env.local`, `.env.[mode]`, `.env.[mode].local`, as in Vite. `process.env` wins over all of them.

`envPrefix` defaults to `["VITE_", "PUBLIC_"]`. Matching keys are available as `import.meta.env.*` and inlined as `process.env.PREFIX_*`; a bare `import.meta.env` is an object of all of them plus `MODE`/`DEV`/`PROD`/`SSR`/`BASE_URL`. Values follow dotenv syntax: `export KEY=v`, `# comments`, `'`/`"`/`` ` `` quotes, multi-line quoted values, `\n` expanded in double quotes. Unlike Vite, there is no `$VAR`/`${VAR}` expansion: a value is taken literally. `define` applies in `dev` and `build`.

Both modes are token-aware, so a `define` key can't corrupt a string literal, a comment, or an unrelated longer identifier. `build` uses `Bun.build({ define })` directly. `dev` has no equivalent — Bun's dev bundler exposes no JS-level `define` hook — so substitution runs through a generated boundary- and comment/string-aware scanner instead.

Builtins: `MODE` (the `--mode`), `BASE_URL`, `SSR` (always `false`), and `DEV`/`PROD`. As in Vite, `build` is always `PROD` whatever its `--mode`; `dev` is `DEV` except with `--mode production`. `process.env.NODE_ENV` is defined to match (`production` when `PROD`, else `development`) unless `define` sets it. `dev` and `build` write `.steambun/env.d.ts` from public keys. Reference the builtins with:

```ts
/// <reference types="steambun/client" />
```

### Env schema

`envSchema` takes a [Standard Schema](https://standardschema.dev) (zod, valibot, arktype, ...) for the merged `.env*` files and `process.env`:

```ts
import { defineConfig } from "steambun";
import { z } from "zod";

export default defineConfig({
  envSchema: z.object({
    DATABASE_URL: z.url(),
    PUBLIC_API_URL: z.url(),
    PUBLIC_ANALYTICS: z.stringbool().default(false),
  }),
});
```

- `dev`, `build`, and `preview` validate before starting and list every failing key (names and messages only, never values). In `dev`, fixing a `.env*` file or the config restarts the server; `build` fails. `steambun doctor` runs the same check as `env-schema`.
- `dist/server.js` and a compiled binary check at startup against their own `process.env`, and exit `1` on failure. Public keys come from build time, since they're already inlined into the client.
- The schema's output is what gets inlined: `import.meta.env.PUBLIC_ANALYTICS` is the boolean `false`, not the string `"false"`, and defaults fill in missing public keys. Typed values must be JSON (string, number, boolean, array, plain object); a `Date` or `bigint` output fails validation with the key named. `process.env.PUBLIC_*` is always the raw string from the environment, so a key that only exists as a schema default is undefined there.
- `.steambun/env.d.ts` types `import.meta.env` from the schema's output type. Public keys the schema doesn't declare stay `string`; server-only keys (no `envPrefix`) are never on `import.meta.env`.
- TypeScript config only — a schema can't live in `bunfig.toml`. `defineConfig` keeps the schema's type; a plain `export default { ... }` does too.

## API routes

Set `api` to a directory (for example `"./src/api"`). Each file becomes a `Bun.serve` route.

- Named exports `GET`, `POST`, and the other HTTP methods, or a default export for every method
- `[id].ts` → `/api/:id` (`req.params.id`)
- `[...slug].ts` → `*` wildcard
- `[[...slug]].ts` → the parent path and a wildcard
- A catch-all must be the last segment: `[...slug]/foo.ts` throws at `dev`, `build`, and `routes`
- Skipped, not routes: `.d.ts` declaration files, `*.test.*` and `*.spec.*` files, and any file or directory whose name starts with `_` (put helpers in `_lib/`)

A file with none of those exports (a typo such as `export const get`) prints a warning and is not served.

With `api` set, `/api` belongs to API routes: an unmatched `/api` or `/api/*` request (any method) returns `404` with `{ "error": "Not Found" }` in every `appType`, never `index.html`. A `[...slug].ts` or `[[...slug]].ts` route handles its own misses, and `publicDir` files under `/api/` are not served.

When two files map to the same path (parameter names don't matter: `[id].ts` and `[slug].ts` collide), `[[...slug]].ts` gives up its parent path to the other file (`index.ts` over `[[...slug]].ts`), and otherwise the lexically-first file wins (`a.ts` over `a.tsx` over `a.js` over `a.jsx` for the same stem). The losing file is not loaded. Every collision is printed once, as a warning, when any server starts and by `steambun routes`. A literal segment, `:param`, and `*` never collide; Bun routes the most specific match.

Frontend HMR and `bun --hot` reload API modules together.

### Server-only modules

Client bundles in `dev` and `build` fail when they import server code:

- Any `*.server.*` module (`db.server.ts`, `auth.server.tsx`, ...). The error names the importing file and specifier, and is checked before `resolve.alias`, so `@/db.server` is caught too.
- Any file under `api`, however it's reached.

```text
[steambun] src/main.ts imports "./db.server", a server-only module (*.server.*), into client code. Move the shared part to a module without ".server", or use `import type`.
```

`import type` from either is fine; types are erased before bundling, which is how the typed `api()` client reads route modules. A dependency's own `.server` files under `node_modules` are left alone.

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

`ws.data.params` carries the route's `:param` values, same as `req.params`. `drain`, `ping`, `pong`, and `error(error, ws)` are forwarded too; without an `error` handler, a throw is printed and the socket stays open. Middleware still runs first — a middleware `Response` (401, etc.) blocks the upgrade. A request without an `Upgrade` header falls through to `GET` (or the default handler) if present, else `426`. Bun allows exactly one server-level `websocket` handler; steambun merges file-based WebSocket routes and `server.proxy`'s `ws: true` connections into it automatically.

```ts
import { ws } from "steambun/client";

const chat = ws("/api/chat/:room", { params: { room: "42" }, reconnect: true });
chat.on("message", (ev) => console.log((ev as MessageEvent).data));
chat.send("hello");
```

`ws(path, { params?, query?, protocols?, reconnect? })` mirrors `api()`/`href()` — `path` is checked against routes exporting `websocket`; `reconnect: true` (or `{ maxAttempts?, baseDelayMs? }`, defaults 10 and 250ms) retries with exponential backoff capped at 30s, and the returned `close()` never reconnects. `on(event, fn)` returns an unsubscribe function. `send()` throws while a reconnect is pending (it isn't queued), so guard it with the `open`/`close` events if you reconnect.

### Server-Sent Events

A response with `Content-Type: text/event-stream` automatically gets `server.timeout(req, 0)` so Bun's idle timeout doesn't cut the stream — no manual call needed.

### Error responses

Every JSON error body steambun produces is `{ "error": string, ...detail }`, so `SteambunApiError.body.error` is always the message: `400` from [validation](#validation) (`issues`), `502` from the proxy (`target`), `426` and `500` from a WebSocket route, and an uncaught throw's `500` (`"Internal Server Error"`; in `dev`, the thrown message plus `stack`, `method`, `path`, `route`). The static file server in `preview` answers `404`/`400` with plain text; unmatched `/api` paths are JSON, as above.

### Typed API client

`dev` and `build` write `.steambun/routes.d.ts`: every API route path with its `:param` names and a `typeof import(...)` reference to its module, plus every page path. It augments ambient types in `"steambun/client"` — no manual wiring needed, just make sure `.steambun/` is reachable by `tsc` (it is by default).

Wrap a handler in `route()` (from `"steambun/runtime"`) so its return value becomes `Response.json(...)` (`undefined` becomes an empty `204`) and its real type flows through to the client:

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

const link = href("/api/users/:id", { params: { id: "42" } }); // "/api/users/42"
```

`href(path, { params?, query? })` takes the same `params`/`query` options as `api()` and `ws()`; `query` is appended as a query string (`href("/about", { query: { tab: "info" } })` → `"/about?tab=info"`; array values repeat the key). `api()`, `href()`, and `ws()` throw if a `:param` in the path has no value in `params`.

`api(method, path, { params?, query?, body?, init? })` substitutes `:param` segments, appends `query` (array values repeat the key, other values are stringified), JSON-encodes `body` (without overriding a caller-set `content-type`), prefixes `import.meta.env.BASE_URL`, and throws a `SteambunApiError` (`status`, `body`, and a message that includes the method and path) on a non-2xx response. On success, a `204`/`205` or empty body resolves `undefined`, a non-JSON response resolves raw text, and anything else resolves parsed JSON. Without `route()`, a handler returning a bare `Response` types as `unknown` — parse it yourself.

### Validation

Pass [Standard Schema](https://standardschema.dev) validators (zod, valibot, arktype, ...) as `route()`'s first argument to check `params`, `query`, and `body` before the handler runs. The handler receives the parsed output; the schemas' input types become `api()`'s `query`/`body` types.

```ts
// src/api/users/[id].ts
import { route } from "steambun/runtime";
import { z } from "zod";

export const PATCH = route(
  {
    params: z.object({ id: z.coerce.number() }),
    body: z.object({ name: z.string().min(1) }),
  },
  ({ params, body }) => ({ id: params.id, name: body.name }),
);
```

```ts
await api("patch", "/api/users/:id", { params: { id: "42" }, body: { name: "" } });
// throws SteambunApiError, status 400
await api("patch", "/api/users/:id", { params: { id: "42" }, body: { name: 1 } });
// type error: name must be a string
```

- Any failure returns `400` with `{ error: "invalid request", issues: [{ in, path, message }] }` — `in` is `"params"`, `"query"`, or `"body"`, `path` is dotted (`"items.0.id"`). Every location is checked, so one response lists all issues.
- `query` is the URL's search params as an object; a repeated key becomes an array. Use coercing schemas (`z.coerce.number()`) for non-string values.
- `body` is parsed from JSON (malformed JSON is a `400`), or from form data for `application/x-www-form-urlencoded`/`multipart/form-data` (repeated keys become arrays). Any other `content-type` is passed as text; an empty body is `undefined`. Without a `body` schema the request body is left unread.
- steambun has no schema library dependency — it only calls the `~standard.validate` interface.

`route()` imports from `"steambun/runtime"`, which a `compile: true` binary can't resolve inside an api route file — the binary dynamically imports api routes from its embedded assets, which can only reach Bun/Node builtins. Keep compiled-binary api routes on bare handlers (the same applies to a schema library import).

## Middleware

`middleware: [auth()]` is `(req, next) => Response`; an entry that isn't a function throws at startup. It wraps API routes and proxy entries, after `server.cors` and `server.headers`, in `dev`, `preview`, `dist/server.js`, and compiled binaries alike. HTML pages, `publicDir` files, and `preview`'s static files are never wrapped, so `server.cors`, `server.headers`, and `middleware` don't reach them in any mode (Bun's native routes can't be wrapped, oven-sh/bun#17608). In `bunfig.toml`, use specifiers: `middleware = ["./src/auth.ts"]`.

## Proxy

`server.proxy` maps a path prefix to a target string or `{ target, changeOrigin?, rewrite?, ws? }`. `ws: true` proxies WebSockets: close codes and reasons pass through both ways, the client socket is paused until the upstream connects, and an upstream that can't be reached or drops closes the client with `1014 Bad Gateway`. The target's own path is kept in front of the (rewritten) request path, like Vite and http-proxy: `target: "http://host/v1"` with `rewrite: (p) => p.replace(/^\/api/, "")` sends `/api/foo` to `/v1/foo`.

An unreachable target (connection refused, DNS failure) returns `502` with `{ error: "proxy target unreachable", target }` instead of an unhandled rejection. `changeOrigin: true` rewrites `Host` and `Origin` to the target's and sets `X-Forwarded-Proto`, `X-Forwarded-Host`, and `X-Forwarded-For`, without overwriting a forwarded value the incoming request already carries. Hop-by-hop headers (`Connection`, `Keep-Alive`, `Proxy-Authenticate`, `Proxy-Authorization`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`, and any header named in `Connection`) are stripped from both the outgoing request and the returned response. A request whose normalized path falls outside the prefix (`/api/%2e%2e/admin`) returns `404` instead of being proxied.

## Plugins and macros

Bun `onResolve` / `onLoad` plugins in `plugins` run in `dev` and `build`. Macros (`import { foo } from "./foo.ts" with { type: "macro" }`) run at bundle time. There is no steambun config key for macros.

A `plugins` entry with no `setup` is instead treated as a **steambun hooks** object — a plain `{ name?, ...hooks }` for participating in steambun's own lifecycle rather than Bun's bundler:

| Hook | When | Signature |
| --- | --- | --- |
| `configResolved` | End of `loadConfig`, once per hook plugin | `(config: ResolvedConfig) => void \| Promise<void>` |
| `configureApp` | End of `createApp`, before `serveOptions` is built | `(app: App, ctx: { mode: "dev" \| "preview" }) => void \| Promise<void>` |
| `buildStart` | Before `Bun.build()` for the HTML entries | `(ctx: { entrypoints: string[] }) => void \| Promise<void>` |
| `transformHtml` | After the build, per output HTML file | `(html: string, ctx: { path: string }) => string \| Promise<string>` |
| `closeBundle` | End of `build()`, after the `compile` binary if enabled; also runs (errors logged) when the build or a size budget fails | `(ctx: { outDir: string }) => void \| Promise<void>` |

A plugin object matching neither a Bun plugin (`setup`) nor any hook key throws `[steambun] Unrecognized plugin at index N` — catches a typo'd hook name instead of silently no-op'ing.

## Programmatic API

`dev`, `build`, and `preview` (options typed `DevCommandOptions`, `BuildCommandOptions`, `PreviewCommandOptions`) are exported from `"steambun"` alongside `defineConfig`, `loadConfig`, and `EnvValidationError` (thrown when `envSchema` fails; its `issues` list every failing key), for tooling that wants to drive steambun without the CLI. The config and plugin types (`UserConfig`, `UserConfigFn`, `ConfigEnv`, `Plugin`, `SteambunHooks`, `BuildOptions`, `ServerOptions`, `App`, `Middleware`, ...) are exported from there too.

`createApp({ config, mode: "dev", htmlRoutes?, apiDir? })` or `createApp({ config, mode: "preview", outDir, cache?, deployed?, apiDir? })`, exported from `"steambun/runtime"`, builds the same route table `dev` and `preview` serve from: HTML entries and `publicDir` files (`dev`), `server.proxy`, `api`, and (in `"preview"` mode) the static asset and SPA-fallback routes. `cache` (default `true`) remembers each path's resolved file; `steambun preview` passes `false` so a rebuild shows up without a restart, while `dist/server.js` and compiled binaries keep the startup cache and pass `deployed: true`, which limits the [Host check](#host-and-origin-checks) to an explicit `server.allowedHosts`. It returns `{ routes, middleware, serveOptions, fetch, close, routeTable, collisions }` — pass `serveOptions` to `Bun.serve` alongside `port`/`hostname`/`tls`, call `fetch(req)` to dispatch a request through a real, lazily started `Bun.serve` instance bound to those routes (handy in tests — call `close()` afterward to stop it), or call `routeTable()` to inspect the rows directly (not printed automatically).

## Compile

Two different Bun compile modes:

| Key | Bun equivalent | Output |
| --- | --- | --- |
| `build.standalone: true` | `--compile --target=browser` | One `.html` per entry, with JS, CSS, and relative assets inlined |
| `compile: true` | `--compile` | A single binary (default `bin/server`) written by `steambun build`. Steambun embeds static assets, API routes, proxy, and middleware |

`compile` also accepts an options object instead of `true`:

| Key | Default | Behavior |
| --- | --- | --- |
| `compile.targets` | host only | Cross-compile targets, e.g. `["bun-linux-x64", "bun-darwin-arm64"]`. One binary per target, named `bin/server-<target>` (`.exe` for `bun-windows-*`). Downloads the target's runtime; not exercised in CI |
| `compile.outDir` | `"bin"` | Output directory for compiled binaries |
| `compile.windows` | | `{ icon?, hideConsole?, title?, publisher?, version?, description?, copyright? }` |
| `compile.autoloadDotenv` | `false` | Whether the binary loads `.env` files at runtime. Bun defaults this `true`; steambun defaults it `false` — a compiled server should get its config from real env vars, not files that may not ship with the binary |
| `compile.autoloadBunfig` | `true` (Bun's default) | Whether the binary loads `bunfig.toml` at runtime |
| `compile.bytecode` | `false` | Bun bytecode cache, for faster startup |

```toml
[steambun.compile]
targets = ["bun-linux-x64", "bun-darwin-arm64"]
outDir = "bin"

[steambun.compile.windows]
title = "My App"
```

## Examples

Each has `dev`, `build`, and `preview` scripts, and builds with `steambun build --root examples/<name>`.

| Directory | What it shows |
| --- | --- |
| [`examples/minimal`](examples/minimal) | `index.html` and `steambun.config.ts` |
| [`examples/bunfig`](examples/bunfig) | `bunfig.toml` only, `build.splitting` |
| [`examples/zero-config`](examples/zero-config) | Same app, no config file |
| [`examples/standalone`](examples/standalone) | `build.standalone: true` |
| [`examples/multi-page`](examples/multi-page) | Three pages sharing a module, `build.splitting` |
| [`examples/fullstack`](examples/fullstack) | API routes (`[id]`), the typed `api()` and `ws()` clients, a file-based WebSocket chat route, middleware, WebSocket proxy, `.env`, a macro, a second HTML entry, Bun plugins, a `SteambunHooks` plugin, `build.splitting`, `compile: true` |
| [`examples/testing`](examples/testing) | `createApp({ mode: "preview" }).fetch()` inside `bun test` — no browser needed |

## Development

Single package at the repo root (`src/`); `examples/*` are workspace members depending on `steambun: file:../..` (Bun's `workspace:*` only resolves siblings under the `workspaces` glob, not the root package itself).

```bash
bun install
bun run typecheck   # tsc across the workspace
bun run lint        # biome check
bun run knip        # unused files, exports, and dependencies
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
| Middleware wraps only API and proxy routes, in every mode | Native HTML/asset routes can't be wrapped (oven-sh/bun#17608) | `src/runtime/middleware.ts` |
| File-based API routes | No route auto-discovery | `src/runtime/api-routes.ts` |
| `import.meta.glob` | No bundle-time glob imports | `src/util/import-glob.ts` |
