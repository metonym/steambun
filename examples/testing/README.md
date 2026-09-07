# testing

Demonstrates steambun's recommended testing pattern: exercising a file-based
API route through `createApp({ mode: "preview" }).fetch()` inside `bun test`,
no browser needed.

**Caveat:** `fetch()` uses steambun's own route matcher and returns a
**blank 200** for HTML/static routes — assert on API, proxy, or `publicDir`
routes only, never on page content.

```bash
bun install && bun test
```
