# steambun

Mac apps from a web page and a thin Swift shell. About 1 MB with no
server. Add a Bun core when you need SQLite, child processes or an HTTP
API.

```html
<!-- index.html -->
<h1>Notes</h1>
<script type="module" src="./main.ts"></script>
```

```sh
steambun dev          # a browser tab, with hot reload
steambun app --open   # build and open build/Notes.app
```

No config file. steambun reads the app from its folder:

| File               | Gives                                              |
| ------------------ | -------------------------------------------------- |
| `package.json`     | The name: `"notes"` makes `Notes.app`              |
| `index.html`       | The page                                           |
| `core.ts`          | A Bun core. Without it, the app ships with no Bun. |
| `native/bridge.ts` | Your own native ops, in Swift                      |

## Features

- **Develop in a browser tab.** The app runs the same page. Hot reload
  keeps scroll, typed text and focus. A core reloads without dropping
  its sockets or child processes.
- **One schema, two compilers.** Declare a native op in TypeScript. A
  missing Swift handler fails the Swift build. A wrong op name fails the
  TypeScript build.
- **End-to-end tests in `bun test`.** A test launches the real app,
  hidden, and sends real AppKit clicks and keys. A launch takes about
  0.3 s. The same test runs in a headless tab.
- **Scriptable.** Every step is a command that exits 0 or 1. A failed
  test saves a screenshot, the HTML and the logs. Browser panes take
  commands over HTTP.
- **Small.** About 1 MB with no core. No dependencies. One `swiftc`
  call, no Xcode project.

See [Why steambun](docs/why.md) for the comparison with Electron and
Tauri, and when not to use it.

## Requirements

- macOS 14 or later, on Apple silicon
- [Bun](https://bun.sh/) 1.4.4 or later
- Xcode Command Line Tools: `xcode-select --install`
- zstd: `brew install zstd`

## Quick start

```sh
mkdir notes && cd notes
bun init -y
bun add steambun
echo '{ "extends": "steambun/tsconfig.json" }' > tsconfig.json
```

Add `index.html` from the top of this page, and `main.ts`:

```ts
import { getSetting, loadSettings, setSetting } from "steambun/ui";

await loadSettings();
const h1 = document.querySelector("h1")!;
h1.textContent = getSetting("title") ?? "Notes";
h1.contentEditable = "true";
h1.oninput = () => setSetting("title", h1.textContent ?? "");
```

```sh
bunx steambun dev            # open the URL it prints
bunx steambun app --open     # build and open build/Notes.app
```

## Examples

Start with `hello`. See [examples/](examples).

| Example                           | Shows                                                                               | `.app` |
| --------------------------------- | ----------------------------------------------------------------------------------- | ------ |
| [`hello`](examples/hello)         | A page, no config                                                                   | 876 KB |
| [`native-op`](examples/native-op) | A Swift op of your own, a menu and a toolbar                                        | 992 KB |
| [`core`](examples/core)           | A Bun core with an API and SQLite; a React page                                     | 40 MB  |
| [`todo-bar`](examples/todo-bar)   | A menu bar app: glass, Apple Intelligence, notifications, a SwiftUI settings window | 1.1 MB |
| [`load-bar`](examples/load-bar)   | A menu bar app whose core runs while it's closed                                    | 40 MB  |

## Docs

| Doc                                  | Covers                                                    |
| ------------------------------------ | --------------------------------------------------------- |
| [How it works](docs/architecture.md) | Page, shell and core; why Swift and Bun; speed; size      |
| [Guide](docs/guide.md)               | Cores, the dev loop, release, folders, menu bar apps, web |
| [Config](docs/config.md)             | Every field and its default                               |
| [API](docs/api.md)                   | `steambun/core`, `steambun/ui`, your own native ops       |
| [Testing](docs/testing.md)           | `steambun/test`: backends and methods                     |
| [CLI](docs/cli.md)                   | Every command and flag                                    |
| [Why steambun](docs/why.md)          | Comparisons, agents, limits, status                       |

## Package

| Import                | Runs in      | Exports                                     |
| --------------------- | ------------ | ------------------------------------------- |
| `steambun/ui`         | The page     | `native`, settings, window glue, hot reload |
| `steambun/core`       | Bun          | `serve()`, `home()`, system state, logs     |
| `steambun/config`     | Your config  | `defineApp`                                 |
| `steambun/schema`     | Your bridge  | `defineBridge`, `op`, `t`                   |
| `steambun/test`       | `bun test`   | `describeApp`, `launch`, `test`             |
| `steambun/tools`      | Your scripts | The functions behind the CLI                |
| `steambun/svelte`     | `bunfig`     | The Svelte 5 plugin. Install `svelte`.      |
| `steambun/native.css` | The page     | System font, colors and pointer             |

steambun is young. See [Status](docs/why.md#status).
To work on steambun, see [CONTRIBUTING](CONTRIBUTING.md).
