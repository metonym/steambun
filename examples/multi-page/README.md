# multi-page

Three pages — `index`, `about`, `blog` — that share `src/nav.ts` and import
`src/shared.css`.

- `server.port`: `5178`
- `build.splitting`: `true` — pulls `src/nav.ts` into its own shared chunk
- `src/shared.css` is bundled into each page's own stylesheet

```bash
bun install && bun run dev
```
