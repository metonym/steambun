# steambun

Steambun is a CLI and config for HTML apps that run on Bun. `steambun dev` starts `Bun.serve` with HMR. `steambun build` runs `Bun.build`. Both use the same bundler.

Steambun adds what Bun does not: a config file, `import.meta.env` and `.env` loading, file-based API routes, middleware, an HTTP/WebSocket proxy, `publicDir`, `preview`, `analyze`, HTML shell minify, and compile that includes those pieces in the output.

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
| `steambun analyze` | Report outputs, packages, and duplicates from the last build's metafile |
| `steambun routes` | Print the route graph (HTML, `publicDir`, `api`, `proxy`) without starting a server |

| Flag | Meaning |
| --- | --- |
| `--port <n>` | Port for `dev` and `preview` |
| `--host [addr]` | Bind address. Omit the value, or set `server.host: true`, to bind `0.0.0.0` |
| `--mode <name>` | Mode. Default `development` for `dev`, `production` for `build` |
| `--config <path>` | Config file (skips discovery) |
| `--root <path>` | Project root (default: cwd) |
| `--json` | Machine-readable output for `analyze` and `routes` |
| `--why <text>` | `analyze` only: print up to 3 shortest import chains from an entry to a path containing `<text>` |

## HTML entries

Every `*.html` file under the project root is an entry, except files in `node_modules`, `.git`, `.steambun`, `dist`, and `public`.

| File | Route |
| --- | --- |
| `index.html` | `/`. Unmatched paths fall back to this file when `appType` is `"spa"` (default) |
| `about.html` | `/about` |
| `about/index.html` | `/about` |

File lookup runs first in both modes: `/about` serves `about.html`, `/about/` serves `about/index.html`. After a miss, `"spa"` serves `index.html` and `"mpa"` returns 404. `appType` applies to `dev`, `preview`, and `compile`.

## Configuration

Discovery order:

1. `steambun.config.ts` / `.mts` / `.js` / `.mjs`
2. `bunfig.toml`

`--config` overrides discovery. If both a TypeScript config and `bunfig.toml` exist, the TypeScript file is the steambun config. `steambun dev` still merges the project `bunfig.toml` into `.steambun/bunfig.toml` so Bun still sees `[install]`, `[define]`, `preload`, and `[serve.static]` plugins.

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

Native Bun keys apply as steambun config: `[serve] port`, `[define]`, `[serve.static]`. All other steambun keys go under `[steambun]`. Plugin and middleware values in TOML are module specifiers, not inline functions.

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

[steambun.resolve.alias]
"@" = "./src"
```

## Server and build

| Key | Default | Behavior |
| --- | --- | --- |
| `appType` | `"spa"` | `"spa"` or `"mpa"`. After file lookup, unmatched paths get `index.html` (`spa`) or 404 (`mpa`). Applies to `dev`, `preview`, and `compile` |
| `server.port` | `5173` | Listen port |
| `server.host` | `false` (`127.0.0.1`) | `true` binds `0.0.0.0` |
| `server.open` | off | Open a browser after listen. `true` opens `/`. A string is a path |
| `server.cors` | `false` | CORS middleware |
| `server.headers` | | Extra response headers |
| `server.https` | | `{ key, cert, ca?, passphrase? }` paths, resolved against `root`. Maps to `Bun.serve({ tls })` |
| `server.idleTimeout` | Bun default (10s) | Seconds of inactivity before Bun closes the connection. For SSE, call `server.timeout(req, 0)` in the handler |
| `server.maxRequestBodySize` | Bun default (128MB) | Max request body in bytes |
| `preview.port` / `host` / `open` | port `4173` | Same shapes as `server.*` |
| `base` | `"/"` | `import.meta.env.BASE_URL` and Bun `publicPath` |
| `resolve.alias` | | Bun `onResolve` plugin in `dev` and `build` |
| `build.outDir` | `"dist"` | Build output directory |
| `build.assetsDir` | `"assets"` | Asset subdirectory |
| `build.sourcemap` | `false` | `true` / `"inline"` / `"external"` |
| `build.minify` | `true` | `boolean`, `{ whitespace, syntax, identifiers, keepNames }`, or `"esbuild"` / `"terser"` (both use Bun's minifier) |
| `build.drop` | `["debugger"]` in production | Identifiers to drop |
| `build.manifest` | `false` | Write `manifest.json` |
| `build.target` | `"browser"` for HTML | `"browser"` / `"bun"` / `"node"` |
| `build.bytecode` | off | Only applied when `compile: true` |
| `build.splitting` | off | `Bun.build({ splitting })`. Shared modules and `import()` become hashed chunks under `assetsDir`. Ignored for `standalone` and `compile` |
| `build.cssChunking` | off | `Bun.build({ cssChunking })`. Only effective with multiple CSS-importing entries |
| `build.minChunkSize` | | `Bun.build({ minChunkSize })`. Requires `build.splitting` |
| `build.budgets` | | Glob → max size (`"250kb"`, `"1.5mb"`, or a byte count). `steambun build` fails when an output exceeds its budget (checked on raw, uncompressed size) |
| `build.precompress` | `false` | `false` or a subset of `["gzip", "br", "zstd"]`. Writes `.gz`/`.br`/`.zst` siblings for compressible files (JS, CSS, HTML, SVG, JSON, txt, map, XML, wasm) at least `precompressMinSize` bytes, skipping a variant that doesn't beat the original by 5% |
| `build.precompressMinSize` | `1024` | Minimum file size, in bytes, to precompress |
| `build.server` | `true` | Write `dist/server.js`, a bundled, dependency-free copy of the preview server. Run it with `bun dist/server.js`; `PORT` and `HOST` env vars work as in `steambun preview`. Skipped for `build.standalone` |

After JS/CSS minify, steambun collapses tag whitespace in the HTML output.

`steambun build` writes `.steambun/metafile.json` (Bun's build metafile) so `steambun analyze` can report on it after the fact, without a full rebuild.

`steambun preview` and `dist/server.js` serve assets under `assetsDir` with `Cache-Control: public, max-age=31536000, immutable` (they're content-hashed) and everything else with a weak `ETag` and `Cache-Control: no-cache` (304 on a matching `If-None-Match`); HTML always gets `no-cache`. When `build.precompress` produced a `.gz`/`.br`/`.zst` sibling, a matching `Accept-Encoding` serves it with `Content-Encoding` set and the original file's `Content-Type`.

## publicDir

Default `"public"`. Files are not bundled. `public/favicon.ico` is served at `/favicon.ico`.

- `dev`: each file is an exact `Bun.serve` route
- `build`: the directory is copied into `outDir`
- HTML under `public/` is not an app entry
- A missing directory is ignored
- `false` disables it

## Environment

Files, later overriding earlier: `.env`, `.env.local`, `.env.[mode]`, `.env.[mode].local`. `process.env` wins.

`envPrefix` defaults to `["VITE_", "PUBLIC_"]`. Matching keys are available as `import.meta.env.*` and inlined as `process.env.PREFIX_*`. `define` applies in `dev` and `build`.

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

Frontend HMR and `bun --hot` reload API modules together.

## Middleware

`middleware: [auth()]` is `(req, next) => Response`. It wraps API routes and proxy entries. In `bunfig.toml`, use specifiers: `middleware = ["./src/auth.ts"]`.

## Proxy

`server.proxy` maps a path prefix to a target string or `{ target, changeOrigin?, rewrite?, ws? }`. `ws: true` proxies WebSockets.

## Plugins and macros

Bun `onResolve` / `onLoad` plugins in `plugins` run in `dev` and `build`. Macros (`import { foo } from "./foo.ts" with { type: "macro" }`) run at bundle time. There is no steambun config key for macros.

## Programmatic API

`dev`, `build`, and `preview` are exported from `"steambun"` alongside `defineConfig` and `loadConfig`, for tooling that wants to drive steambun without the CLI.

`createApp({ config, mode, htmlRoutes?, outDir?, apiDir? })`, exported from `"steambun/runtime"`, builds the same route table `dev` and `preview` serve from: HTML entries, `publicDir`, `server.proxy`, `api`, and (in `"preview"` mode) the static asset and SPA-fallback routes. It returns `{ routes, middleware, serveOptions, fetch, routeTable }` — pass `serveOptions` to `Bun.serve` alongside `port`/`hostname`/`tls`, call `fetch(req)` to dispatch a request without a socket (handy in tests), or call `routeTable()` to inspect the rows directly (not printed automatically).

## Compile

Two different Bun compile modes:

| Key | Bun equivalent | Output |
| --- | --- | --- |
| `build.standalone: true` | `--compile --target=browser` | One `.html` per entry, with JS, CSS, and relative assets inlined |
| `compile: true` | `--compile` | A single binary. Steambun embeds static assets, API routes, proxy, and middleware |

## Examples

All use `bun run dev` / `build` / `preview`.

| Directory | What it shows |
| --- | --- |
| [`examples/minimal`](examples/minimal) | `index.html` and `steambun.config.ts` |
| [`examples/bunfig`](examples/bunfig) | `bunfig.toml` only, `build.splitting` |
| [`examples/zero-config`](examples/zero-config) | Same app, no config file |
| [`examples/standalone`](examples/standalone) | `build.standalone: true` |
| [`examples/fullstack`](examples/fullstack) | API routes (`[id]`), middleware, WebSocket proxy, `.env`, a macro, a second HTML entry, Bun plugins, `compile: true` |

## Development

Single package at the repo root (`src/`, `bin/`); `examples/*` are workspace members depending on `steambun: file:../..` (Bun's `workspace:*` only resolves siblings under the `workspaces` glob, not the root package itself).

```bash
bun install
bun run typecheck   # tsc --noEmit across the workspace
bun run lint        # biome check
bun run test        # bun test
```

`file:` installs copy the package into `node_modules/.bun`'s store rather than symlinking it live. Re-run `bun install` after editing `src/` to see the change from an example.
