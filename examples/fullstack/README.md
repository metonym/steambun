# fullstack

The full surface: file-based API routes, a proxy, middleware, plugins, and a
compiled build.

- `api`: `"./src/api"` — `health.ts`, `echo.ts`, `users/[id].ts`, a WebSocket
  route `chat/[room].ts`
- `server.proxy`: `/legacy` → a separate "legacy" backend, `ws: true`
- `middleware`: a request logger
- `plugins`: Bun plugins plus a `SteambunHooks` plugin
- `build.sri` / `build.csp`: `"strict"`
- `build.splitting` / `build.importMap`: `true`
- `compile`: `true`

Run `bun run dev` in one terminal and `bun run legacy-api` in a second (a
plain `Bun.serve` on port `4200` that `/legacy/*` proxies to — without it the
proxy routes fail, everything else still works).

```bash
bun install && bun run dev
```
