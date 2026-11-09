# zero-config

The same app as `examples/minimal`, but with no `steambun.config.ts` at all —
`dev`/`build`/`preview` run entirely on steambun's defaults.

- No config file
- `server.port`: `5173` (default)
- `build.outDir`: `"dist"` (default)

```bash
bun install && bun run dev
```
