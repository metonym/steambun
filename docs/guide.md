# Guide

Building an app day to day: adding a core, the dev loop, folders, menu bar apps, the web build and UI frameworks.

## Add a core

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

## Run the core on the user's Bun

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

For updates, make a signing key once with `steambun release keygen`, and
set `update: { url }` in the config. `steambun app` puts the public key
from `native/.keys/update.pub` in the app. Each release then writes a feed
that any static host can serve:

```sh
steambun release build/Notes.app feed/ old/Notes.app
```

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
- **Easy to find.** "Where does this run?" tells you where the file is.

steambun helps the layout hold:

- **`steambun check` keeps code in its runtime.** It walks the page's
  imports and the core's imports. It fails if the page reaches `bun`,
  `bun:*` or `steambun/core`, or if the core reaches `steambun/ui` or a
  component file. It prints the import chain that crossed. Shared
  modules and type-only imports are fine. `steambun build` runs it
  first. It takes about 7 ms on a large app.
- **One output folder.** `steambun build` and `steambun app` both write
  to `build/`.

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

## Glass

Set `glass: true` and the shell puts real glass behind the page:
Liquid Glass on macOS 26 and later, and the older blur on 14 and 15. The
page has no background by default, so the glass shows wherever you
don't paint one. `todo-bar` uses it.

```json
"steambun": { "glass": true }
```

The page can't draw glass itself. CSS `backdrop-filter` blurs, but it
has no lens or highlight. So the glass sits behind the whole page, and
the page decides where it shows.

In the Mac app, `<html>` gets a `data-glass` attribute. Use it to style
the two cases apart:

```css
/* A browser tab has no glass: give it a plain background. */
html:not([data-glass]) body {
  background: Canvas;
}
```

## SF Symbols

The page can use any SF Symbol. In the Mac app, `symbol()` gives a URL
the shell draws as a PNG. Use it as a CSS mask, so the icon takes the
text color:

```ts
import { symbol } from "steambun/ui";

const url = symbol("checklist", { size: 16, weight: "medium" });
el.style.setProperty("--icon", url ? `url("${url}")` : myIcon);
```

```css
.icon {
  background: currentColor;
  mask: var(--icon) center / contain no-repeat;
}
```

In a tab, `symbol()` gives null. Apple's license allows SF Symbols only
on Apple platforms, so a tab needs its own icons. `todo-bar`'s `icons.ts`
has small SVGs for the same names.

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
plugins = ["steambun/svelte"]
```

The dev server and `steambun build` read the same list, so dev and
release can't drift.

| Framework                | Setup                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Plain TS, Lit, Preact, … | Nothing                                                                                                                      |
| React                    | Nothing. Bun has JSX and Fast Refresh built in.                                                                              |
| Svelte 5                 | `bun add svelte`, then list `steambun/svelte`. It rebuilds a component in about 8 ms and puts no HMR code in release builds. |
| Vue, Solid               | A community Bun plugin                                                                                                       |
