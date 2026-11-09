# steambun

**A web page + Swift.** Write your UI in plain TypeScript, or any
framework. steambun turns it into a real Mac app of about 1 MB. The Swift
compiler checks its native features, and your tests drive real AppKit.
When you need a server, SQLite or child processes, add a Bun core.

```html
<!-- index.html -->
<h1>Notes</h1>
<script type="module" src="./main.ts"></script>
```

```sh
steambun dev          # a browser tab, with hot reload
steambun app --open   # build and open build/Notes.app, about 1 MB
```

That's a whole app, with no config file. steambun reads the rest from
your folder:

- The **name** comes from `package.json`: `"notes"` makes `Notes.app`.
- The **page** is `index.html`.
- A **core** is there if `core.ts` is. Add the file, and the app has a
  Bun server. Delete it, and the app ships with no Bun.
- **Native ops** are there if `native/bridge.ts` is.

You add a config file only to change a default, such as menus. You
write no Swift until you need a native API that steambun doesn't have.
You test the real app from `bun test`, in TypeScript, in under a second.

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
over a typed bridge. The `.app` is the ~850 KB shell plus your page.

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

The goal is a Mac app that is as small and as fast as it can be, and
still quick to build. Each runtime does the job it's best at:

| Layer               | Runs in              | Its job                                                         | Why this runtime                                                                                    |
| ------------------- | -------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Shell**           | Swift, AppKit        | Windows, menus, Dock, hotkeys, files, signing, updates          | Native APIs with no bindings in between. ~850 KB. Starts in tens of ms.                             |
| **Page**            | WebKit (`WKWebView`) | The UI                                                          | WebKit ships with macOS, so it adds nothing to the app. Hot reload, dev tools and any UI framework. |
| **Core** (optional) | Bun                  | The work: processes, PTYs, SQLite, servers, file watching, sync | A full standard library in one runtime, with fast startup and no dependencies.                      |

**Bun is not the UI.** The WebView draws. Bun is the engine behind it.
A core is a long-running process that owns the app's state and its work.
It keeps running when the window closes. It can run git, hold a hundred
terminals, watch a folder, sync with a server and answer an HTTP API
for agents, with no window open at all. The page is one client of the
core. A script, an agent or a second window can be another.

That split is why the blend works:

- **Swift does only what needs the OS.** It's the thinnest layer that
  can own the window, menus and system events. There's no Swift you
  must write, and no Xcode project.
- **WebKit draws, and it's fast enough.** ade renders at 120 fps on
  ProMotion in a WebView. The OS already loads WebKit for other apps,
  so the page costs memory but no download size.
- **Bun does the heavy work off the UI thread.** Spawning, parsing,
  diffing and IO happen in the core, so the page stays free to draw.
- **Each layer is optional except the shell.** Leave out the core and
  the app is about 1 MB with no Bun. Leave out your own Swift and the
  stock shell builds in seconds.

**The cost:** two processes and a WebView use more memory than pure
AppKit, about 100 MB against 30 MB. A Bun core adds a few hundred ms to
launch. See "When not to use it".

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

Bun is also fast where an app feels it. The core starts in tens of ms,
the dev server bundles a page in about 15 ms, and `bun test` runs ade's
111 unit tests in about 250 ms.

### Zero dependencies

steambun has no dependencies. It uses Bun's built-ins, Node's `fs`,
`os` and `path`, and the macOS SDK. The Swift shell links only AppKit,
WebKit and a static libzstd for updates.

The one exception is opt-in: the Svelte plugin imports `svelte/compiler`,
so an app that uses it installs `svelte` itself. A vanilla app installs
`steambun` and nothing else.

Why it matters:

- **Nothing to audit or update** except Bun and steambun.
- **Small, fast installs.** No `node_modules` tree to download.
- **A smaller attack surface.** No transitive packages run in your core.
- **Less to break.** A Bun upgrade is the only upgrade.

## Why steambun

The parts aren't new. Electron, Tauri, Wails and Electrobun all put a web
UI in a native host. steambun makes different choices about how the parts
fit.

**The shell is optional.** Most of your work happens in a browser tab,
with hot reload and the browser's dev tools. The app runs the same core
and the same page, so the tab isn't a mock-up. Frameworks built on IPC
only work inside the app.

**Hot reload covers the server too.** Edit the core and it reloads, but
open sockets, child processes and the link to the shell stay alive. Edit
a component and the page keeps its scroll positions, typed text, focus
and caret. Only Swift edits need a rebuild, which takes about 4 s.

**One schema, checked by two compilers.** You declare a native op once,
in TypeScript. The page gets a typed `native.call`. The shell gets a
Swift protocol it must implement. Forget a handler and the Swift build
fails. Rename an op and the TypeScript build fails.

**End-to-end tests are fast, and they're just TypeScript.** A test is a
`bun test` file. It launches the real app, drives it, and checks the
page, the menus and the shell's state. A launch takes about 0.3 s, so a
whole suite runs in a few seconds:

- **The real app, not a mock.** Keys are real AppKit events. They go
  through the menu bar and key equivalents before the page, as a
  person's keys do. You can fake sleep, network loss and Low Power Mode.
- **Out of your way.** The app runs hidden: no Dock icon, no focus
  taken, and no window you can see. You keep working while it runs.
- **Isolated.** Each launch gets its own data folder and WebKit store.
- **Two backends, one test file.** The same test runs in the Mac app or
  in a headless tab. The tab needs no shell and runs on any machine with
  Bun.
- **One language.** The app, its config, its build scripts and its tests
  are all TypeScript. An agent can write a test, run it and read the
  result with no Xcode and no second toolchain.

Other stacks make this harder. Tauri's WebDriver tests don't run on
macOS, because there's no driver for `WKWebView`. Electron's Playwright
support is marked experimental. Native Mac apps use XCUITest, which
needs Xcode, Swift and the accessibility tree.

**The core knows what the Mac is doing.** Sleep, wake, network and Low
Power Mode reach the core as typed events. Pause sync while the Mac
sleeps, and slow it down on battery.

**Agents can drive it.** Browser panes take commands over HTTP, and the
whole build and test loop runs from the command line. See "Built for
agents".

**Plain Swift, no extra layers.** One `swiftc` call, no Xcode project, an
~850 KB shell. AppKit is right there, with no Rust or Go bindings between
you and it.

**Mac only, on purpose.** steambun uses real Mac menus, the Dock, global
hotkeys and per-file signed updates. It doesn't settle for what every
platform shares.

## Built for agents

Coding agents can build, run, drive and check a steambun app without a
person in the loop.

- **Everything is a command.** `steambun build`, `steambun app` and
  `bun test` exit 0 or 1. No Xcode project, no GUI step, no signing
  dialog. Config is one TypeScript file.
- **Errors say what to fix.** A missing native handler is a Swift
  compile error naming the method. A wrong op name or argument is a
  TypeScript error. `steambun gen --check` catches stale generated code.
- **Browser panes agents can drive.** A pane is a real `WKWebView` in
  your layout. An agent drives it over HTTP: open, navigate, click,
  type, press keys, scroll, resize, run JavaScript, take screenshots and
  read console logs. `type` and `press` send trusted key events, and
  focus goes back to the user's cursor after. Without the shell, the
  same API runs a headless `Bun.WebView`, so agents work in a tab too.
- **Agents see what the user sees.** In the app, the agent drives the
  pane on screen. The user can watch, or take over.
- **Tests an agent can run.** The harness drives the real app with real
  AppKit events and can fake sleep, network loss and Low Power Mode. An
  agent can check a UI change end to end, then read one log file.
- **Token auth.** Pages of the core's own origin may use the browser
  API. Anything else needs the token your `browser.auth` checks.

Measured browser pane round trips, on an M-series Mac:

| Operation                  | Native pane | Headless           |
| -------------------------- | ----------- | ------------------ |
| Open a local page          | ~60 ms      | ~165 ms cold       |
| `click`, `type`, `press`   | 2–13 ms     | ~1 ms + next frame |
| `eval`                     | 1–2 ms      | 0.1 ms             |
| Screenshot, 1340×683 at 2× | 17–31 ms    | ~9 ms              |

## Performance

A WebView isn't the bottleneck people think it is. The numbers below
are from ade, a large steambun app with a PR graph, diffs of 140+ files
and a terminal, unless noted.

| Measure                           | Result                                                                    |
| --------------------------------- | ------------------------------------------------------------------------- |
| Frame rate on a ProMotion screen  | 120 fps. WebKit caps pages at 60 fps by default; the shell lifts the cap. |
| Jank on heavy paths (perf gate)   | At most 1 frame over 50 ms per scenario, none over 100 ms                 |
| View switch                       | 1–3 ms                                                                    |
| Warm launch, `open` to first rows | ~500 ms                                                                   |
| First paint, minimal app          | 15 ms after navigation starts                                             |
| CPU at idle                       | ~0%                                                                       |
| Memory, shell + core + WebKit     | ~150 MB                                                                   |
| Edit to pixels in dev             | 20–60 ms                                                                  |
| Svelte component rebuild          | ~8 ms                                                                     |
| Shell build                       | ~4 s                                                                      |

The page runs in the same WebKit as Safari, with its GPU compositing
and JIT. Most slow web apps are slow because of their code, not the
WebView. With steady rendering habits (fixed row heights, no layout
thrash, work off the main thread) a WebView app holds 120 fps.

## When not to use it

- **You need Windows or Linux.** The shell is AppKit.
- **You need a small download, a core, and users without Bun.** With no
  core, the app is about 1 MB. A core on the user's Bun keeps it near
  1 MB, but only for users who have Bun. A bundled Bun core has a floor
  of about 24 MB on disk (see "Size"), and a steambun core is about 40 MB.
- **You need a tiny memory or launch floor.** A WebView costs tens of MB
  and about 50 ms before your page paints. A Bun core adds more memory
  and a few hundred ms.
  A pure AppKit app can launch in about 100 ms and idle at 30 MB.
- **You need what only an Xcode target can make.** Widgets, Share and
  Finder extensions, Quick Look previews and other app extensions need
  their own bundle targets. steambun builds one app, not extensions.
- **You want the system to own your documents.** `NSDocument` gives
  autosave, Versions, iCloud Drive and the standard document window
  for free. In steambun, the core owns your files, so you write that
  yourself.

Smoothness isn't on this list. A WebView app can match a native one on
frame rate, as ade does. Native wins on the floor (memory, launch) and on
reach (extensions, system document handling), not on drawing speed.

## Features

- **No config to start.** The name, the page, the core and your native
  ops come from the files in your folder. A config only changes defaults.
- **Window and menus from config.** Size, title bar, menus, key
  equivalents, a global hotkey and `Info.plist` keys all come from
  `steambun.config.ts`. No Swift.
- **Menus follow the page.** A menu item sends a command to the page. The
  page can rebind keys at run time, and the menu bar shows the new keys.
- **Settings that survive.** With no core, they live in the page's
  `localStorage` at the fixed `steambun://app` origin. With a core, the
  core keeps them, so they survive a new port and the tab and app share
  them. JSON by default. Bring your own store, such as SQLite.
- **About 1 MB with no core.** The shell serves your built page from the
  bundle. It launches to first paint in about 50 ms.
- **Native browser panes.** Place a real `WKWebView` in your layout with
  a `<div>`. Agents and scripts can drive it over HTTP: navigate, click,
  type, take a screenshot, run JavaScript.
- **System state.** `onSystem()` in the core reports sleep, network and
  Low Power Mode.
- **120 Hz.** The page gets the screen's refresh rate, and gets it again
  when the window moves to another screen.
- **Small updates.** Patches go per file, with `zstd --patch-from`. A UI
  change is tens of KB. Any static host works: an ed25519 signature
  covers the manifest, so the host needs no trust. The update installs
  with an atomic swap on quit.
- **End-to-end tests in TypeScript.** `describeApp` launches the real
  app, hidden, from `bun test`. ade's 17 tests take about 9 s. See
  "Testing".
- **One binary for the core,** when you have one. AOT and trimmed, with
  the UI, SQLite and your assets inside. Or about 0.5 MB of JS on the
  user's own Bun, with `bun: "system"`.

## Quick start

You need macOS 14 or later, Bun, Xcode's command line tools, and
`brew install zstd`. The updater links zstd.

```sh
mkdir notes && cd notes
bun init -y
bun add steambun
```

Add `index.html` from the top of this page, a `tsconfig.json` that is
just `{ "extends": "steambun/tsconfig.json" }`, and the script:

```ts
// main.ts
import { getSetting, loadSettings, setSetting } from "steambun/ui";

await loadSettings();
const h1 = document.querySelector("h1")!;
h1.textContent = getSetting("title") ?? "Notes";
h1.contentEditable = "true";
h1.oninput = () => setSetting("title", h1.textContent ?? "");
```

Then:

```sh
bunx steambun dev            # open the URL it prints
bunx steambun app --open     # build and open build/Notes.app, about 1 MB
```

Five examples. Each one shows one idea; [examples/](examples) says
which to read first.

| Example                              | Shows                                                 | `.app` |
| ------------------------------------ | ----------------------------------------------------- | ------ |
| [`hello`](examples/hello)         | The smallest app: a page, no config                   | 876 KB |
| [`native-op`](examples/native-op) | An op of your own in Swift, and a menu                | 892 KB |
| [`core`](examples/core)           | A Bun core with an API and SQLite (the page is React) | 40 MB  |
| [`todo-bar`](examples/todo-bar)   | A menu bar app with no core                           | 880 KB |
| [`load-bar`](examples/load-bar)   | A menu bar app whose core runs with the panel closed  | 40 MB  |

### Add a core

Add `core.ts` at the app's root. It serves the page:

```ts
// core.ts
import { serve } from "steambun/core";
import page from "./index.html";

serve({ routes: { "/": page, "/api/hi": () => Response.json("hi") } });
```

Nothing else changes, and you edit no config. `steambun build` now
compiles the core with the page inside, and `steambun app` puts it in
the `.app` as a helper. To keep a `core.ts` that isn't a steambun core,
set `core: false`.

### Run the core on the user's Bun

A bundled core is about 40 MB, almost all of it Bun. If your users
already have Bun, as developers often do, skip it:

```ts
export default defineApp({ bun: "system" });
```

`steambun build` then bundles the core as plain JS, and the `.app` runs
it with the user's `bun`. The React example drops from 40 MB to 1.3 MB.
Launch time stays the same: first paint in about 280 ms either way.

The shell looks for `bun` in `~/.bun/bin`, `/opt/homebrew/bin` and
`/usr/local/bin`, then asks the login shell. Apps opened from Finder
don't get your shell's `PATH`, so the shell checks the usual places
first. `STEAMBUN_BUN` overrides the search.

The user's Bun must be at least the version that built the app. Build
with a stable Bun if you can. If the user has no Bun, or an older one,
the window shows the command to install or upgrade it. The trade:

|                | Bundled (default)  | `bun: "system"`                          |
| -------------- | ------------------ | ---------------------------------------- |
| Size           | ~40 MB             | ~1 MB plus your core's JS                |
| Users need Bun | No                 | Yes, at least your build's version       |
| Bun version    | The one you tested | Whatever the user has, at or above yours |
| Trim and AOT   | Yes                | Not needed                               |

Use `"system"` for tools for developers. Keep the default for apps for
everyone.

## How you work with it

### Day to day: a browser tab

```sh
steambun dev
```

This serves the page with hot reload, on the port from your config. Open
it in any browser. UI edits apply in 20–60 ms. With a core, it runs the
core from source under `bun --hot` instead, and core edits reload the
server and keep its live resources.

In a tab, `native.inShell` is false and `native.has()` returns false for
every op. Write the page so it works without them.

### Inside the app

```sh
steambun app             # once, and again after Swift or config edits
steambun dev --native
```

This runs the dev server (or your source core) and points the built
shell at it, so hot reload still works. Right-click and choose Inspect Element for Web Inspector.

### Release

```sh
steambun build           # build/page: the page. With a core, build/core/<name>: one AOT binary
SIGN_ID="Developer ID Application: …" VERSION=1.0.0 steambun app
```

Then notarize and staple `build/<name>.app` as you would any Mac app.

## Folder structure

Organize by **where the code runs**. Each runtime gets one place. Small
apps stay flat. Bigger apps grow folders, and the entry files stay at the
root, so steambun can still infer the config.

The smallest app, a page with no core:

```
notes/
├── package.json        name → Notes.app
├── index.html          the page
├── main.ts
└── test/app.e2e.ts
```

A bigger app, with a core and native ops:

```
notes/
├── package.json
├── steambun.config.ts  only to set an id, menus or a window size
├── index.html          entry: the page (runs in WebKit)
├── core.ts             entry: the core (runs in Bun). Its presence turns the core on.
│                       Or core/index.ts, if you'd rather keep it in core/.
├── ui/                 page code
├── core/               core code: routes, db, jobs
├── native/
│   ├── bridge.ts       the op schema, shared by TypeScript and Swift
│   └── Sources/        your Swift handlers
├── scripts/            release and one-off tools
├── test/               *.test.ts (unit) and *.e2e.ts (steambun/test)
└── build/              all output: the .app, the page, the core. Gitignore it.
```

Why this layout:

- **One folder per runtime.** `ui/` runs in WebKit, `core/` in Bun and
  `native/` in Swift. If `ui/` imports from `core/`, you can see the bug
  in the import path: it would pull Bun APIs into the page.
- **Entry files at the root.** steambun looks for `index.html` and
  `core.ts`. In a big app they stay thin and import from `ui/` and
  `core/`.
- **`native/` exists only if you write Swift.** Delete it and the app
  builds with the stock shell.
- **People and agents find things the same way.** "Where does this run?"
  tells you where the file is.

steambun helps the layout hold:

- **`steambun check` keeps code in its runtime.** It walks the page's
  imports and the core's imports. It fails if the page reaches `bun`,
  `bun:*` or `steambun/core`, or if the core reaches `steambun/ui` or a
  component file. It prints the import chain that crossed. Shared
  modules and type-only imports are fine. `steambun build` runs it
  first. It takes about 7 ms on ade.
- **One output folder.** `steambun build` and `steambun app` both write
  to `build/`.

ade came first, so it differs in two ways. Its core entry is
`core/cli.ts`, set in its config. Its page code is split across `app/`
and `ui/`.

## The config

Every field is optional. Put the config in `steambun.config.ts`, which
gets type checks, or in a `"steambun"` object in `package.json`. If both
exist, the `.ts` file wins.

```ts
import { defineApp } from "steambun/config";

export default defineApp({
  id: "com.example.notes",
  window: { width: 1100, height: 720, titlebar: "hidden" },
  menus: {
    File: [{ title: "New Note", command: "note.new", key: "mod+n" }],
    View: [
      { title: "Toggle Sidebar", command: "sidebar", key: "mod+\\" },
      "-",
      "reload",
      "fullscreen",
    ],
  },
  hotkey: "ctrl+alt+Space",
  plist: { NSCameraUsageDescription: "Notes uses the camera for scans." },
});
```

| Field     | Default                                                    | What it does                                                                                                                                 |
| --------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`    | `package.json`'s name in PascalCase: `todo-bar` is TodoBar | Menu bar name, bundle name, binary name                                                                                                      |
| `id`      | `local.steambun.<name>`                                    | Bundle id, reverse DNS. Set it before you sign: it names the app's data, so it can't change after you ship. A signed build fails without it. |
| `home`    | `~/Library/Application Support/<name>`                     | The core's data folder: `home()` in the core                                                                                                 |
| `port`    | Derived from `id`, 20000–29999                             | The core's port, or the dev server's with no core                                                                                            |
| `window`  | 1280×800, min 640×400, hidden title bar                    | Size and title bar                                                                                                                           |
| `menus`   | none                                                       | Menus between Edit and Window. `Window` and `Help` keys add to those menus.                                                                  |
| `appMenu` | none                                                       | Extra items in the app menu                                                                                                                  |
| `hotkey`  | none                                                       | A global chord that shows or hides the app (or its panel, in a menu bar app)                                                                 |
| `menuBar` | off                                                        | `true` or `{ icon, title, width, height }`: a menu bar app. See "Menu bar apps".                                                             |
| `update`  | none                                                       | The update feed URL and its ed25519 public key                                                                                               |
| `icon`    | none                                                       | An `.icns` file                                                                                                                              |
| `plist`   | none                                                       | Extra `Info.plist` keys                                                                                                                      |
| `core`    | `core.ts` or `core/index.ts`, if one exists                | The core's entry file. `false`: no core, so the app is the page and the shell.                                                               |
| `bun`     | `"bundled"`                                                | `"system"` runs the core on the user's Bun. See "Run the core on the user's Bun".                                                            |
| `page`    | `index.html`                                               | The page's HTML entry, when there's no core                                                                                                  |
| `bridge`  | `native/bridge.ts`, if it exists                           | Your own native ops                                                                                                                          |
| `swift`   | `native/Sources`                                           | Your Swift files                                                                                                                             |
| `out`     | `build`                                                    | Where all output goes: the `.app`, the page, the core                                                                                        |

A menu item is `"-"` for a separator, a standard role (`"copy"`,
`"reload"`, `"fullscreen"`, …), or `{ title, command, key? }`. A command
item sends `menu.command` to the page:

```ts
native.command("note.new", newNote);
```

## Menu bar apps

Set `menuBar` and the app lives in the menu bar. It has no Dock icon
and no window at launch. A click on the icon shows the page in a panel
under it. The panel hides when you click elsewhere, like a menu. A
right-click on the icon shows Quit and Check for Updates. The global
`hotkey`, if set, shows and hides the panel.

```json
{
  "name": "todo-bar",
  "steambun": {
    "menuBar": { "icon": "checklist", "width": 320, "height": 400 }
  }
}
```

`icon` is an SF Symbol name. `title` is text next to the icon, and the
app can change both at run time. It works with or without a core:

|                    | No core                                                                | With a core                                                                            |
| ------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| The page loads     | At launch: it's the whole app                                          | On the first click                                                                     |
| Set the title from | The page: `native.call("menuBar.set", { title })`                      | The core: `setMenuBar({ title })`, or the page                                         |
| Idle cost          | The shell and one web content process                                  | The shell and the core. No web content process until the first click.                  |
| Example            | `examples/todo-bar`: to-dos, with the open count as the title. 876 KB. | `examples/load-bar`: the core puts the load average in the menu bar every few seconds. |

The page gets `menuBar.open` events (`{ open: true }` or `false`), to
refresh when the panel shows or stop timers when it hides. The
`menuBar.close` op hides the panel, for example on Escape.

Measured with `load-bar`, idle with the panel never opened: the shell
uses 21.8 MB and the core uses 6.8 MB. No web content process runs.

## The core: `steambun/core`

Only for apps with a core.

`serve()` takes the same options as `Bun.serve`, with the same types,
route params included. It adds:

| Path                     | What it does                                                |
| ------------------------ | ----------------------------------------------------------- |
| `/_steambun/ws`          | The shell's link. It checks the shell's token.              |
| `/_steambun/settings`    | UI settings. `settings: false` turns it off.                |
| `/_steambun/browser/:op` | Browser panes and their API. `browser: false` turns it off. |

```ts
import { serve, home, onSystem, log } from "steambun/core";
import { Database } from "bun:sqlite";
import page from "./index.html";

const db = new Database(home("notes.db"));

serve({
  routes: {
    "/": page,
    "/api/notes": {
      GET: () => Response.json(db.query("select * from notes").all()),
    },
    "/api/notes/:id": (req) =>
      Response.json(
        db.query("select * from notes where id = ?").get(req.params.id),
      ),
  },
  // Let a local agent drive browser panes, not only the page.
  browser: {
    auth: (req) =>
      req.headers.get("authorization") === `Bearer ${process.env.TOKEN}`,
  },
});

onSystem(({ asleep, online, lowPower }) => {
  log(`asleep=${asleep} online=${online} lowPower=${lowPower}`);
});
```

Other exports: `home(...parts)` for paths in the data folder,
`jsonSettings()` and the `SettingsStore` type for your own store,
`log`/`logger`, `spawnEnv()` and `which()` for the login shell's `PATH`,
and `nativeLinked()`/`waitLinked()`.

Keep long-lived resources (timers, child processes, sockets) on
`globalThis`, or a core hot reload starts a second copy.

## The page: `steambun/ui`

Plain TypeScript, with no UI framework inside.

```ts
import {
  native,
  loadSettings,
  getSetting,
  setSetting,
  startShell,
  keeper,
} from "steambun/ui";

await loadSettings(); // before modules that read settings
setSetting("theme", "dark");

if (native.has("app.info")) {
  const { version, hz } = await native.call("app.info");
}
native.send("menu.setKeys", { map: { "note.new": ["mod+n"] } }); // no-op in a tab
native.watch("screen.hz", ({ hz }) => setFrameBudget(1000 / hz));
native.command("note.new", newNote);

startShell({ paint: ".note-row" }); // optional: logs first paint when this shows

// Keep scroll, text and focus across hot reloads.
if (import.meta.hot) {
  const keep = keeper();
  import.meta.hot.on("bun:beforeUpdate", keep.beforeUpdate);
  import.meta.hot.on("bun:afterUpdate", keep.afterUpdate);
}
```

| API                         | What it does                                                                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native.inShell`            | True inside the app                                                                                                                                                                                |
| `native.has(op)`            | True if this shell has the op                                                                                                                                                                      |
| `native.call(op, args)`     | Runs a native op. Typed. Rejects with `NativeUnavailable` in a tab.                                                                                                                                |
| `native.send(op, args)`     | Call and forget. Does nothing in a tab.                                                                                                                                                            |
| `native.on(event, fn)`      | Hears a shell event. Returns an unsubscribe function.                                                                                                                                              |
| `native.watch(event, fn)`   | Like `on`, but first calls `fn` with the last payload, if one came. For state such as `screen.hz`.                                                                                                 |
| `native.command(id, fn)`    | Runs `fn` when the menu item with this command is chosen                                                                                                                                           |
| `native.last(event)`        | The last payload of an event                                                                                                                                                                       |
| `loadSettings({ durable })` | Loads settings from the core. `durable` picks which keys the core keeps. The rest stay in local storage. With no core, all keys stay in local storage.                                             |
| `startShell(opts)`          | Window glue: drag areas, the right-click menu, first paint. It starts with the defaults when the page imports `steambun/ui`. Call it only to change them: selectors in `opts` add to the defaults. |
| `keeper(opts)`              | The hot reload state keeper                                                                                                                                                                        |

## The same page on the web

The page is a normal web page, so the app and a website can share one
UI. `steambun build --web` bundles the page alone, as a static site, in
`build/web`. With a core, it bundles the HTML the core serves. Asset
paths are relative, so the site works at any path on any host.

The page needs no changes to run outside the shell:

- `native.inShell` and `native.has()` are false, and `native.call()`
  rejects. Check `has()` first, and hide or replace native features.
  For example, the menus' commands need another way in, such as buttons
  or a command list.
- Settings stay in `localStorage`, because there's no core to hold them.
- `steambun check` already keeps Bun code out of the page.

Where the app and the web differ:

- **The core's API.** If the page calls `/api/…`, the web needs a
  server with the same API at the same origin. Share the types between
  the two. Don't put the app's core on the internet as it is: it trusts
  the local shell, and it can run processes. A web server needs its own
  auth and a smaller API.
- **Keys.** The browser keeps ⌘W, ⌘T, ⌘N and ⌘L for itself. In the app,
  native menus can use them.
- **Engines.** The app runs WebKit only. On the web, test in Chrome and
  Firefox too.
- **The title bar.** The shell sets `--shell-titlebar` to the hidden
  title bar's height. A browser doesn't, so read it with a fallback:
  `var(--shell-titlebar, 0px)`.

A test builds `examples/hello` and `examples/core` this way and loads
them in a browser.

## UI frameworks

steambun doesn't care which framework you use. A framework that needs a
compile step is a Bun plugin, listed once in `bunfig.toml`:

```toml
[serve.static]
plugins = ["steambun/plugins/svelte.ts"]
```

The dev server and `steambun build` read the same list, so dev and
release can't drift.

| Framework                | Setup                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Plain TS, Lit, Preact, … | Nothing                                                                                                                                 |
| React                    | Nothing. Bun has JSX and Fast Refresh built in.                                                                                         |
| Svelte 5                 | `bun add svelte`, then list `steambun/plugins/svelte.ts`. It rebuilds a component in about 8 ms and puts no HMR code in release builds. |
| Vue, Solid               | A community Bun plugin                                                                                                                  |

## Your own native ops

When you need an API that steambun doesn't have, add an op. It takes two
files.

**1. Declare it** in `native/bridge.ts`:

```ts
import { defineBridge, op, t } from "steambun/schema";

export default defineBridge({
  ops: {
    "sound.play": op(t.struct("SoundPlayArgs", { name: t.string }), t.bool),
  },
  events: {
    "notes.dropped": t.struct("NotesDropped", { paths: t.list(t.string) }),
  },
});
```

**2. Write the Swift** in `native/Sources/`:

```swift
import AppKit

extension Shell {
  func soundPlay(_ a: SoundPlayArgs) -> Bool {
    NSSound(named: a.name)?.play() ?? false
  }
}
```

`steambun app` generates a Codable struct for each type and a protocol
with one method per op. If a method is missing, the build fails and
Xcode's fix-it writes the stub. To send an event, call the generated
`emitNotesDropped(NotesDropped(paths: …))`.

**3. Type the page** with one declaration file:

```ts
// native/page.d.ts
import type bridge from "./bridge.ts";
declare module "steambun/ui" {
  interface Register {
    bridge: typeof bridge;
  }
}
```

Now `native.call("sound.play", { name: "Tink" })` returns
`Promise<boolean>`. A wrong name or a wrong argument is a type error.

Schema types: `t.string`, `t.number`, `t.int`, `t.bool`, `t.none`,
`t.list(x)`, `t.map(x)`, `t.opt(x)` and `t.struct(name, fields)`. Ops run
on the main thread and return at once. For slow work, return right away
and send an event when the work is done.

## Testing

`steambun/test` starts your app and drives it from `bun test`. It works
with or without a core. Tests are plain TypeScript, run hidden, and take
about as long as unit tests:

| Suite                                | Tests | Mac app | Tab   |
| ------------------------------------ | ----- | ------- | ----- |
| `examples/hello`                     | 1     | 0.4 s   | 0.3 s |
| `examples/core` (React page, a core) | 3     | 1.0 s   | 0.5 s |
| `examples/todo-bar` (menu bar app)   | 4     | 0.7 s   | 0.4 s |
| All five examples                    | 13    | 1.2 s   | 0.7 s |
| ade (git, terminals, panes, sync)    | 17    | 2.6 s   | —     |

Times are the whole run, launch included, on an M-series Mac, with the
app run from source. Test files run at once; one at a time, ade takes
7.5 s and the examples 3.2 s.

```ts
import { expect } from "bun:test";
import { describeApp, test } from "steambun/test";

describeApp({ ready: "h1" }, (app) => {
  test("typing updates the heading", async () => {
    await app.click("input");
    await app.type("Ada");
    await app.waitFor(
      `document.querySelector("h1").textContent === "Hello, Ada"`,
    );
  });

  test("the name survives a relaunch", async () => {
    await app.relaunch();
    expect(await app.text("h1")).toBe("Hello, Ada");
  });
});
```

Run it with `steambun test`. It rebuilds the shell first if the shell is
older than its Swift, its bridge or its config, so a test never runs old
Swift. `--tab` runs the tab backend, and `--both` runs one, then the
other. Arguments after `--` go to `bun test`, such as a file, a folder
or `-t`.

Test files run at once, one worker each (`bun test --parallel`). Each
launch has its own home folder, WebKit store and port, so apps don't
see each other. Keep anything an app saves under its home, not in
`UserDefaults` or a fixed path. Split a slow file in two to go faster.
`--serial` runs one file at a time.

`describeApp` launches the app once for the block and closes it after.
Where the app can't run (not macOS, or no built shell), it skips the
block and says why. `ready` waits for that selector, and for the page's
scripts to finish, so a test can click at once. Use `launch()` for a
second app, as in `examples/load-bar`.

There are two backends. The test code is the same for both.

| Backend            | Runs in                              | Speed           | Use it for                                              |
| ------------------ | ------------------------------------ | --------------- | ------------------------------------------------------- |
| `native` (default) | The real shell, from source or built | ~0.3 s a launch | Menus, key equivalents, paste, native ops, system state |
| `tab`              | A headless `Bun.WebView`, no shell   | About 2× faster | Page logic, on any machine with Bun                     |

Set `STEAMBUN_TEST_BACKEND=tab` to switch. `app.native` tells a test
where it runs, so it can skip what a tab can't do.

**The native backend runs the app hidden.** It has no Dock icon, takes
no focus from the app you're in, and its window is invisible and lets
clicks through. It still draws, so frames, focus and keys work. Set
`STEAMBUN_TEST_SHOW=1` to watch a run.

**Each launch is isolated.** It gets a temp home folder and its own
WebKit store, and `close()` deletes both. Tests never touch the data of
the app you use every day. `relaunch()` keeps the home, the store and
the port, so you can test what survives a restart.

**Input takes the real path.** In the shell, `app.key("mod+k")` goes to
the menus first, then to the page, as a person's key would.
`app.click("#save")` sends a real mouse down and up through AppKit, so
the page sees a trusted click and a view over the page gets it first.
Both work while the app is hidden.

**A failed test saves what it saw.** Import `test` from `steambun/test`,
not `bun:test`. When a test fails, it saves each open app's screenshot,
its HTML and its logs to `build/test-failures/<test name>/`, and prints
the folder. An agent reads that folder; it doesn't need to run the test
again to see what went wrong.

**Agents can see and measure the page.** `app.screenshot(path)` saves a
PNG, even of the hidden window. `app.layout(sel)` returns each match's
box and key styles as JSON, in a fixed order. Two layouts diff cleanly,
so an agent can check a design change in numbers, not only by eye:

```ts
const [row] = await app.layout("#list li");
// { tag: "li", name: "", text: "Buy milk ✕", x: 12, y: 48, w: 296, h: 29,
//   style: { display: "flex", padding: "4px 0px", gap: "8px", … } }
```

| Method                                    | Does                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| `js(expr)`, `waitFor(expr)`               | Read the page, or wait until an expression is true                               |
| `click(sel)`, `click({ x, y })`           | A real click on an element's center, once it shows. `{ count: 2 }` double-clicks |
| `text(sel)`                               | An element's text as shown, once it exists                                       |
| `screenshot(path?)`, `layout(sel)`        | A PNG of the page; boxes and styles as JSON                                      |
| `key(chord)`, `type(text)`, `paste(text)` | Input. `paste` is native only.                                                   |
| `menu(id)`, `menuKey(id)`                 | Run a menu command, or read its key (native only)                                |
| `system({ asleep, online, lowPower })`    | Fake sleep, network loss or Low Power Mode (native only)                         |
| `settings({...})`                         | Write settings as the page would. `null` deletes.                                |
| `go(path)`, `reload()`, `relaunch()`      | Navigate, reload, or quit and start again                                        |
| `until(ok)`                               | Wait until the shell's state passes `ok`, such as a menu bar title (native only) |
| `readLog()`, `waitLog(re)`                | The shell's and core's log                                                       |
| `call(op, args)`                          | Any test op the shell has                                                        |

Launch options: `root` (default: the current folder), `ready` (a
selector to wait for, after the page's scripts run), `seed(home)` to fill the
home before launch, `built` (test the `.app`, or set
`STEAMBUN_TEST_BUILT=1`), `hot`, `env` and `args`. `whyNot()` returns a
reason the tests can't run here, such as "no built shell", or `null`.

## The command line

Run it at the app's root, where `package.json` lives.

| Command                 | What it does                                                                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `steambun dev`          | The page with hot reload, or the core from source under `bun --hot`, on the config's port                                                                                                                         |
| `steambun dev --native` | The same, inside the built shell. `--home DIR` sets the data folder. Arguments after `--` go to the core.                                                                                                         |
| `steambun build`        | Runs `steambun check`, then bundles the page to `build/page`. With a core, compiles the core and its page to one binary in `build/core`, or with `bun: "system"`, bundles them there as JS. `--no-aot` skips AOT. |
| `steambun app`          | Runs `steambun build`, then builds and signs `<out>/<name>.app`. `--open` opens it. With `CORE` set, it uses that core and doesn't build.                                                                         |
| `steambun build --web`  | Bundles the page alone as a static site in `build/web`. See "The same page on the web".                                                                                                                           |
| `steambun test`         | Rebuilds the shell if it's stale, then runs the `*.e2e.ts` tests at once. `--tab` or `--both` picks the backend; `--serial` runs one file at a time. Arguments after `--` go to `bun test`.                                                              |
| `steambun gen`          | Writes the generated Swift. `--check` fails if it's stale.                                                                                                                                                        |
| `steambun check`        | Fails if the page imports Bun code, or the core imports page code. See "Folder structure".                                                                                                                        |

`steambun app` reads `SIGN_ID`, `VERSION`, `BUILD`, `UPDATE_URL`,
`UPDATE_KEY`, `ENTITLEMENTS`, `CORE` and `ZSTD` from the environment.
`steambun/tools` exports the same functions for your own scripts.

### Trim

With a core, `steambun build` trims Bun APIs that the core never names, which saves
about 12 MB. A call to a removed API throws `ERR_FEATURE_REMOVED` at run
time, and `bun test` can't catch it. After you add a dependency or a new
Bun API, run the built binary once, or check with:

```sh
bun build --compile --aot --trim --explain=trim ./core.ts
```

## Size

Measured with Bun 1.4.4:

| Part                                                   | Size       |
| ------------------------------------------------------ | ---------- |
| Swift shell                                            | ~850 KB    |
| `examples/hello`, no core: the whole `.app`            | 876 KB     |
| Core of `examples/core`                                | 40 MB      |
| `examples/core` with `bun: "system"`: the whole `.app` | 1.3 MB     |
| Core of ade (SQLite, PTYs, a terminal engine)          | 43 MB      |
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

## Status

steambun came out of ade, a Mac app for managing PRs, which uses it every day. It's
young. What works and what doesn't:

| Area                                 | Status                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Config, menus, hotkey, `Info.plist`  | Works                                                                                             |
| Apps with no core                    | Works                                                                                             |
| No config file                       | Works                                                                                             |
| A core on the user's Bun             | Works. Tested by hand, not in a test suite yet.                                                   |
| `serve()`, settings, system state    | Works                                                                                             |
| Typed bridge and app ops             | Works                                                                                             |
| Hot reload of page and core          | Works, with tests                                                                                 |
| Browser panes                        | Works                                                                                             |
| CLI: `dev`, `build`, `app`, `gen`    | Works                                                                                             |
| Test harness                         | Works, for any app, in the shell or a tab. Runs hidden.                                           |
| System state with no core            | Not yet. The page can't hear sleep or Low Power Mode.                                             |
| Updater                              | Works in ade. Still needs automatic rollback, a freeze-attack guard and a general release script. |
| Folder conventions, `steambun check` | Works                                                                                             |
| Menu bar apps                        | Works, with tests, with or without a core                                                         |
| The page as a static site (`--web`)  | Works, with tests. The core's API on the web is up to you.                                        |
| Background apps with no UI at all    | Not yet. A menu bar app comes close: with a core, it runs no web view until clicked.              |
| Published to npm                     | Not yet                                                                                           |

macOS 14 or later, Apple silicon only.
