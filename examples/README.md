# Examples

Each example shows one idea. Start with `hello`, then open the one you
need. Every file says in its first lines what it shows and where it
runs: the page, the core, or Swift.

| Example                  | Shows                                                 | Files                   |
| ------------------------ | ----------------------------------------------------- | ----------------------- |
| [`hello`](hello)         | The smallest app: one page, no config                 | `index.html`, `main.ts` |
| [`native-op`](native-op) | An op of your own in Swift, typed in TS, and a menu   | adds `native/`          |
| [`core`](core)           | A Bun core with an API and SQLite. The page is React. | adds `core.ts`          |
| [`todo-bar`](todo-bar)   | A menu bar app with no core                           | `index.html`, `main.ts` |
| [`load-bar`](load-bar)   | A menu bar app whose core runs with the panel closed  | adds `core.ts`          |

In any example:

```sh
bun dev                        # the page in a browser tab, with hot reload
bun app                        # build and open the Mac app
bun run test                   # tests, in the Mac app (rebuilds it if the Swift changed)
bun run test --both            # the same tests, then again in a tab
```
