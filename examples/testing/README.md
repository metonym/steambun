# testing

Demonstrates steambun's recommended testing pattern: exercising a file-based
API route through `createApp({ mode: "preview" }).fetch()` inside `bun test`,
no browser needed. `fetch()` lazily starts a real `Bun.serve` instance bound
to the app's routes and dispatches through it, so the response is exactly
what a real request would get — call `app.close()` when done to stop it.

```bash
bun install && bun test
```
