# fullstack

The full surface: file-based API routes, a proxy, middleware, plugins, and a
compiled build.

- `api`: `"./src/api"` — `health.ts`, `echo.ts`, `users/[id].ts`, a WebSocket
  route `chat/[room].ts`; `main.ts` calls `users/[id]` with the typed `api()`
  client and `about.ts` opens the chat route with `ws()`
- `server.proxy`: `/legacy` → a separate "legacy" backend, `ws: true`
- `middleware`: a request logger
- `plugins`: `bun-plugin-tailwind`, a custom Bun plugin (`.upper` files), and
  a `SteambunHooks` plugin (`configResolved`, `configureApp`, `transformHtml`)
- `.env` and `define`: `PUBLIC_GREETING` and `PUBLIC_TITLE` in `import.meta.env`
- a bundle-time macro (`src/git-sha.ts`) and a second HTML entry (`about.html`)
- `build.splitting`: `true`
- `compile`: `true` — `steambun build` also writes `bin/server`

Run `bun run dev` in one terminal and `bun run legacy-api` in a second (a
plain `Bun.serve` on port `4200` that `/legacy/*` proxies to — without it the
proxy routes fail, everything else still works).

```bash
bun install && bun run dev
```
