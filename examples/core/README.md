# core

A Bun core next to the page. `core.ts` turns it on: no config needed.

- `core.ts` serves the page and `/api/hits`, and keeps the count in
  SQLite under the app's data folder.
- `main.tsx` is the page. It's React, to show that any framework works.

```sh
bun dev   # the core under bun --hot, the page in a tab
bun app   # build and open build/Core.app
```

The .app is about 40 MB, because the core is a compiled Bun binary.
