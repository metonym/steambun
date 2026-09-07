# bunfig

Config lives entirely in `bunfig.toml` — no `steambun.config.ts`. Two pages,
`index.html` and `about.html`, sharing a chunk.

- `[serve] port`: `5173`
- `[steambun.build] splitting`: `true`

```bash
bun install && bun run dev
```
