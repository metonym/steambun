# standalone

`build.standalone: true` — `steambun build` produces one self-contained
`.html` file with JS, CSS, and assets inlined instead of an `outDir` tree.
`build.server` (and `dist/server.js`) is skipped for standalone builds.

- `server.port`: `5178`
- `build.standalone`: `true`

```bash
bun install && bun run dev
```
