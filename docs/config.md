# The config

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
  toolbar: [
    { title: "New Note", command: "note.new", symbol: "square.and.pencil" },
    "-",
    { title: "Share", command: "note.share", symbol: "square.and.arrow.up" },
  ],
  hotkey: "ctrl+alt+Space",
  plist: { NSCameraUsageDescription: "Notes uses the camera for scans." },
});
```

| Field     | Default                                                    | What it does                                                                                                                                                                                                 |
| --------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`    | `package.json`'s name in PascalCase: `todo-bar` is TodoBar | Menu bar name, bundle name, binary name                                                                                                                                                                      |
| `id`      | `local.steambun.<name>`                                    | Bundle id, reverse DNS. Set it before you sign: it names the app's data, so it can't change after you ship. A signed build fails without it.                                                                 |
| `home`    | `~/Library/Application Support/<name>`                     | The core's data folder: `home()` in the core                                                                                                                                                                 |
| `port`    | Derived from `id`, 20000–29999                             | The core's port, or the dev server's with no core                                                                                                                                                            |
| `window`  | 1280×800, min 640×400, hidden title bar                    | Size and title bar                                                                                                                                                                                           |
| `menus`   | none                                                       | Menus between Edit and Window. `Window` and `Help` keys add to those menus.                                                                                                                                  |
| `appMenu` | none                                                       | Extra items in the app menu                                                                                                                                                                                  |
| `toolbar` | none                                                       | A native toolbar: buttons with an SF Symbol, and `"-"` for a flexible space. A click runs the page's `native.command(command)`, as a menu item does. A toolbar keeps the title bar. A menu bar app has none. |
| `hotkey`  | none                                                       | A global chord that shows or hides the app (or its panel, in a menu bar app)                                                                                                                                 |
| `glass`   | off                                                        | Real glass behind the page: Liquid Glass on macOS 26+, the older blur before. See [Glass](guide.md#glass).                                                                                                   |
| `menuBar` | off                                                        | `true` or `{ icon, title, width, height }`: a menu bar app. See [Menu bar apps](guide.md#menu-bar-apps).                                                                                                     |
| `update`  | none                                                       | The update feed URL and its ed25519 public key                                                                                                                                                               |
| `icon`    | none                                                       | An `.icns` file                                                                                                                                                                                              |
| `plist`   | none                                                       | Extra `Info.plist` keys                                                                                                                                                                                      |
| `core`    | `core.ts` or `core/index.ts`, if one exists                | The core's entry file. `false`: no core, so the app is the page and the shell.                                                                                                                               |
| `bun`     | `"bundled"`                                                | `"system"` runs the core on the user's Bun. See [Run the core on the user's Bun](guide.md#run-the-core-on-the-users-bun).                                                                                    |
| `inline`  | none                                                       | Env vars to bake into the built core, by exact name. See below.                                                                                                                                              |
| `page`    | `index.html`                                               | The page's HTML entry, when there's no core                                                                                                                                                                  |
| `bridge`  | `native/bridge.ts`, if it exists                           | Your own native ops                                                                                                                                                                                          |
| `swift`   | `native/Sources`                                           | Your Swift files                                                                                                                                                                                             |
| `out`     | `build`                                                    | Where all output goes: the `.app`, the page, the core                                                                                                                                                        |

`inline` bakes values that the core needs on every Mac, such as an
OAuth client ID, into the built core. `build` and `app` replace each
`process.env.NAME` you list with its value in the shell that runs them,
and print the names they inlined. A var that isn't set stays a lookup at
run time, and the build warns you:

```
✓ core   build/core/MyApp · 58 MB · AOT, trimmed · not set: MYAPP_GITHUB_CLIENT_ID · 1.4 s
! MYAPP_GITHUB_CLIENT_ID isn't set, so the core reads it at run time
```

`dev` runs the core with your shell's env, so `process.env.NAME` gives
the same value in `dev` as in a build.

```ts
inline: ["MYAPP_GITHUB_CLIENT_ID"],
```

```sh
MYAPP_GITHUB_CLIENT_ID=Iv1.abc123 bunx steambun app
```

List each var by its exact name. Bun loads `.env` files on its own, so a
prefix could pick up a token you never meant to ship. Anyone with a copy
of the app can read an inlined value, so never list a secret.

A menu item is `"-"` for a separator, a standard role (`"copy"`,
`"reload"`, `"fullscreen"`, …), or `{ title, command, key? }`. A command
item sends `menu.command` to the page:

```ts
native.command("note.new", newNote);
```
