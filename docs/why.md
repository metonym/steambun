# Why steambun

How steambun compares to Electron and Tauri, what it gives coding agents, and when to use something else.

## How it differs

Electron, Tauri, Wails and Electrobun all put a web UI in a native host.
steambun differs in these ways.

**The shell is optional.** Most of your work happens in a browser tab,
with hot reload and the browser's dev tools. The app runs the same core
and the same page, so the tab isn't a mock-up. Frameworks built on IPC
only work inside the app.

**Hot reload covers the server too.** Edit the core and it reloads, but
open sockets, child processes and the link to the shell stay alive. Edit
a component and the page keeps its scroll positions, typed text, focus
and caret. Only Swift edits need a rebuild, which takes about 5 s.

**One schema, checked by two compilers.** You declare a native op once,
in TypeScript. The page gets a typed `native.call`. The shell gets a
Swift protocol it must implement. Forget a handler and the Swift build
fails. Rename an op and the TypeScript build fails.

**End-to-end tests are fast, and they're TypeScript.** A test is a
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
whole build and test loop runs from the command line. See [Built for agents](#built-for-agents).

**Plain Swift, no extra layers.** One `swiftc` call, no Xcode project, an
~900 KB shell. AppKit, with no Rust or Go bindings in between.

**Mac only, on purpose.** steambun uses real Mac menus, the Dock, global
hotkeys and per-file signed updates, not what every platform shares.

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
  bundle. It goes from launch to first paint in about 0.25 s.
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
  app, hidden, from `bun test`. The examples' 13 tests take about 1.2 s. See
  [Testing](testing.md).
- **One binary for the core,** when you have one. AOT and trimmed, with
  the UI, SQLite and your assets inside. Or about 0.5 MB of JS on the
  user's own Bun, with `bun: "system"`.

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

## When not to use it

- **You need Windows or Linux.** The shell is AppKit.
- **You need a small download, a core, and users without Bun.** With no
  core, the app is about 1 MB. A core on the user's Bun keeps it near
  1 MB, but only for users who have Bun. A bundled Bun core has a floor
  of about 24 MB on disk (see [Size](architecture.md#size)), and a steambun core is about 40 MB.
- **You need a tiny memory or launch floor.** A WebView costs tens of MB
  and about 0.25 s from launch to first paint. A Bun core adds more memory
  and a few hundred ms.
  A pure AppKit app can launch in about 100 ms and idle at 30 MB.
- **You need what only an Xcode target can make.** Widgets, Share and
  Finder extensions, Quick Look previews and other app extensions need
  their own bundle targets. steambun builds one app, not extensions.
- **You want the system to own your documents.** `NSDocument` gives
  autosave, Versions, iCloud Drive and the standard document window
  for free. In steambun, the core owns your files, so you write that
  yourself.

Frame rate isn't on this list. A WebView app can hold 120 fps. Native
wins on memory, launch time, extensions and document handling, not on
drawing speed.

## Status

steambun is young. What works and what doesn't:

| Area                                 | Status                                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Config, menus, hotkey, `Info.plist`  | Works                                                                                                           |
| Apps with no core                    | Works                                                                                                           |
| No config file                       | Works                                                                                                           |
| A core on the user's Bun             | Works. Tested by hand, not in a test suite yet.                                                                 |
| `serve()`, settings, system state    | Works                                                                                                           |
| Typed bridge and app ops             | Works                                                                                                           |
| Hot reload of page and core          | Works, with tests                                                                                               |
| Browser panes                        | Works                                                                                                           |
| CLI: `dev`, `build`, `app`, `gen`    | Works                                                                                                           |
| Test harness                         | Works, for any app, in the shell or a tab. Runs hidden.                                                         |
| System state with no core            | Not yet. The page can't hear sleep or Low Power Mode.                                                           |
| Updater                              | Works, tested by hand. `steambun release` publishes a feed. Needs automatic rollback and a freeze-attack guard. |
| Folder conventions, `steambun check` | Works                                                                                                           |
| Menu bar apps                        | Works, with tests, with or without a core                                                                       |
| The page as a static site (`--web`)  | Works, with tests. The core's API on the web is up to you.                                                      |
| Background apps with no UI at all    | Not yet. A menu bar app comes close: with a core, it runs no web view until clicked.                            |

macOS 14 or later, Apple silicon only.
