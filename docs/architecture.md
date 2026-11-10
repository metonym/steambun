# How it works

The parts of an app, what each runtime does, and the cost in size and speed.

## What it is

A steambun app has two parts, and an optional third:

| Part                | What it is                                                  | You write                                 |
| ------------------- | ----------------------------------------------------------- | ----------------------------------------- |
| **Page**            | Your UI, in any framework, inside a `WKWebView`.            | `index.html` and its imports              |
| **Shell**           | A small Swift app: the window, menus, Dock and native APIs. | Nothing. Optional Swift for your own ops. |
| **Core** (optional) | A Bun server on 127.0.0.1. It serves the page and your API. | `core.ts`                                 |

**With no core** (the default), `steambun build` bundles the page, and
the shell serves it from inside the `.app` at `steambun://app/`. There's
no server, no port and no Bun in the app. The page talks to the shell
over a typed bridge. The `.app` is the ~900 KB shell plus your page.

**With a core** (a `core.ts` file), the page talks to the core over
plain HTTP and WebSocket, the same way it would in a browser tab. At
release, the core and the page compile to one AOT binary, and the shell
runs it as a helper. The `.app` is about 40 MB. With `bun: "system"`,
the app runs the core on the user's own Bun instead, and is about 1 MB.

Either way, the shell adds what a tab can't do, and the page asks
`native.has("op")` before it uses it.

### What you can build with no core

A page with the shell's ops is enough for most small apps:

- **Tools and utilities:** converters, calculators, JSON and regex tools,
  color pickers, a scratchpad.
- **Apps that keep their own data:** notes, to-do lists, journals,
  flashcards, habit trackers. Store data in `localStorage` or IndexedDB.
  WebKit keeps it per app across launches.
- **Clients for web APIs:** dashboards, feed readers, chat or status
  apps over HTTPS and WebSocket. The API must allow CORS from the
  `steambun://app` origin, the same as for any web page.
- **Creative apps:** canvas and WebGL drawing, games, music with Web
  Audio, editors for diagrams or Markdown.
- **Viewers:** a folder of docs, a PDF, a data set you ship in the app.
- **Launchers and menu-driven tools:** a global hotkey shows the window;
  menus and key equivalents come from the config.

You also get the browser's platform, inside a secure context: `fetch`,
WebSocket, Web Crypto, Web Workers, WebAssembly, the clipboard API,
`<input type="file">`, drag and drop and Web Audio.

**What needs a core, or your own native op:**

| You need                           | No core                            | With a core                 |
| ---------------------------------- | ---------------------------------- | --------------------------- |
| Read and write any file            | A native op (a few lines of Swift) | `Bun.file`                  |
| SQLite                             | IndexedDB, or a native op          | `bun:sqlite`                |
| Run CLI tools, git, a terminal     | Not possible                       | `Bun.spawn`, `Bun.Terminal` |
| Call an API with no CORS           | A native op that fetches           | `fetch` in the core         |
| Work after the window closes       | Not possible                       | The core runs on its own    |
| An HTTP API for agents and scripts | Not possible                       | `serve()` routes            |
| Browser panes agents drive         | Not possible                       | `browser` in `serve()`      |
| Settings shared by tab and app     | Each keeps its own                 | The core keeps them         |

Start with no core. Add a `core.ts` when you hit a row on the right.
The page doesn't change: it still uses `steambun/ui`.

## Swift and Bun: who does what

Each runtime does one job:

| Layer               | Runs in              | Its job                                                         | Why this runtime                                                                                    |
| ------------------- | -------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Shell**           | Swift, AppKit        | Windows, menus, Dock, hotkeys, files, signing, updates          | Native APIs with no bindings in between. ~900 KB.                                                   |
| **Page**            | WebKit (`WKWebView`) | The UI                                                          | WebKit ships with macOS, so it adds nothing to the app. Hot reload, dev tools and any UI framework. |
| **Core** (optional) | Bun                  | The work: processes, PTYs, SQLite, servers, file watching, sync | A full standard library in one runtime, with fast startup and no dependencies.                      |

**Bun is not the UI.** The WebView draws. Bun is the engine behind it.
A core is a long-running process that owns the app's state and its work.
It keeps running when the window closes. It can run git, hold a hundred
terminals, watch a folder, sync with a server and answer an HTTP API
for agents, with no window open at all. The page is one client of the
core. A script, an agent or a second window can be another.

Why this split:

- **Swift does only what needs the OS.** It's the thinnest layer that
  can own the window, menus and system events. There's no Swift you
  must write, and no Xcode project.
- **WebKit draws, at 120 fps on ProMotion.** macOS ships WebKit, so
  the page costs memory but no download size.
- **Bun does the heavy work off the UI thread.** Spawning, parsing,
  diffing and IO happen in the core, so the page stays free to draw.
- **Each layer is optional except the shell.** Leave out the core and
  the app is about 1 MB with no Bun. Leave out your own Swift and the
  stock shell builds in seconds.

**The cost:** two processes and a WebView use more memory than pure
AppKit, 60–90 MB at idle against 30 MB. A Bun core adds a few hundred ms to
launch. See [When not to use it](why.md#when-not-to-use-it).

## Why Bun

Bun is a runtime with the standard library a desktop app needs already
inside it. Each of these is a package (or several) in Node:

| A desktop app needs                         | Bun has it built in                         |
| ------------------------------------------- | ------------------------------------------- |
| An HTTP and WebSocket server                | `Bun.serve`, with typed routes              |
| A UI bundler and dev server with hot reload | HTML imports in `Bun.serve`                 |
| TypeScript and JSX                          | Runs them directly. No build step in dev.   |
| React Fast Refresh                          | Built into the dev server                   |
| A database                                  | `bun:sqlite`                                |
| Child processes and a PTY                   | `Bun.spawn`, `Bun.Terminal`                 |
| A headless browser                          | `Bun.WebView`                               |
| A test runner                               | `bun test`                                  |
| A package manager and workspaces            | `bun install`                               |
| A single-file release build                 | `bun build --compile`, with AOT and trim    |
| Shell scripts, TOML, hashing, file IO       | `Bun.$`, `Bun.TOML`, `Bun.hash`, `Bun.file` |

With no core, Bun is your dev tool: the dev server, hot reload, the
bundler and `bun test`. It doesn't ship. With a core, it's also the
runtime.

The core starts in tens of ms, and the dev server bundles a page in
about 15 ms.

### Zero dependencies

steambun has no dependencies. It uses Bun's built-ins, Node's `fs`,
`os` and `path`, and the macOS SDK. The Swift shell links only AppKit,
WebKit and a static libzstd for updates.

The one exception is opt-in: the Svelte plugin imports `svelte/compiler`,
so an app that uses it installs `svelte` itself. A vanilla app installs
`steambun` and nothing else.

Why:

- **Nothing to audit or update** except Bun and steambun.
- **Small, fast installs.** No `node_modules` tree to download.
- **A smaller attack surface.** No transitive packages run in your core.
- **Less to break.** A Bun upgrade is the only upgrade.

## Performance

Measured on a large steambun app with a graph view, diffs of 140+ files
and a terminal, unless noted.

| Measure                           | Result                                                                    |
| --------------------------------- | ------------------------------------------------------------------------- |
| Frame rate on a ProMotion screen  | 120 fps. WebKit caps pages at 60 fps by default; the shell lifts the cap. |
| Jank on heavy paths (perf gate)   | At most 1 frame over 50 ms per scenario, none over 100 ms                 |
| View switch                       | 1–3 ms                                                                    |
| Warm launch, `open` to first rows | ~500 ms                                                                   |
| Launch to first paint, `hello`    | ~250 ms (WebKit's paint); the page's paint report lands at ~330 ms        |
| CPU at idle                       | ~0%                                                                       |
| Memory at idle, all processes     | 60–90 MB. WebKit's GPU process peaks at ~220 MB for a second at launch.   |
| Edit to pixels in dev             | 20–60 ms                                                                  |
| Svelte component rebuild          | ~8 ms                                                                     |
| Shell build                       | ~5 s, or ~0.1 s when no Swift changed                                     |

The page runs in the same WebKit as Safari, with its GPU compositing
and JIT. Slow web apps are usually slow because of their code. With fixed
row heights, no layout thrash and work off the main thread, a WebView
app holds 120 fps.

## Size

Measured with Bun 1.4.4:

| Part                                                   | Size       |
| ------------------------------------------------------ | ---------- |
| Swift shell                                            | ~900 KB    |
| `examples/hello`, no core: the whole `.app`            | 876 KB     |
| Core of `examples/core`                                | 40 MB      |
| `examples/core` with `bun: "system"`: the whole `.app` | 1.3 MB     |
| Core of a large app (SQLite, PTYs, a terminal engine)  | 43 MB      |
| `.app` with a core                                     | 40–46 MB   |
| DMG with a core                                        | ~14 MB     |
| Small update                                           | tens of KB |

With a core, the Bun runtime is about 98% of the app. Your own code is
usually under 1 MB.

### What AOT and trim remove

A compiled core always carries Bun. Even a core that uses no Bun API
needs JavaScriptCore, the event loop and the module loader. If your core
does nothing the page can't, drop it: an app with no core ships no Bun.
If your users have Bun, use theirs: `bun: "system"` ships no Bun either.
AOT and trim cut what's around the runtime:

| `console.log("hi")`, compiled                  | Size                           |
| ---------------------------------------------- | ------------------------------ |
| `--compile`                                    | 118 MB: the whole `bun` binary |
| `--compile --aot`                              | 50 MB                          |
| `--compile --aot --trim`                       | 23.5 MB: the floor             |
| Plus `Bun.serve` and an HTML page              | 29.5 MB                        |
| Plus `Bun.WebView`                             | 33.5 MB                        |
| Plus `bun:sqlite` and `Bun.spawn` (no WebView) | 32.5 MB                        |

Trim works on what your code names. Each Bun API you use brings its
code back. steambun's core adds about 10 MB above the `Bun.serve` floor.
About 4 MB of that is browser panes (`Bun.WebView`). An app that passes
`browser: false` still pays for it today, because the import is static.
Loading it on demand is on the list.
