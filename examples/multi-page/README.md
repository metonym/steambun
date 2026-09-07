# multi-page

Three pages — `index`, `about`, `blog` — sharing `src/nav.ts` and
`src/shared.css`.

- `server.port`: `5178`
- `build.splitting`: `true` — pulls `src/nav.ts` into its own shared chunk
- `build.importMap`: `true` — content-independent chunk ids, so editing
  `nav.ts` only re-hashes its own chunk
- `build.sharedCss`: `{ minSize: 100 }` — extracts `src/shared.css` into one
  shared stylesheet instead of duplicating it per page (default `minSize` is
  `2048`, lowered here for this small example)

```bash
bun install && bun run dev
```
