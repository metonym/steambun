# API

The core's API, the page's API, and your own native ops.

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
import { Database } from "bun:sqlite";
import { home, log, onSystem, serve } from "steambun/core";
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
`nativeLinked()`/`waitLinked()`, and `setHome(dir)` to move the data
folder when no shell runs the core.

Keep long-lived resources (timers, child processes, sockets) on
`globalThis`, or a core hot reload starts a second copy.

## The page: `steambun/ui`

Plain TypeScript, with no UI framework inside.

```ts
import {
  getSetting,
  keeper,
  loadSettings,
  native,
  setSetting,
  startShell,
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
| `symbol(name, opts)`        | A URL for an SF Symbol, to use as a CSS mask. Null in a tab. See [SF Symbols](guide.md#sf-symbols).                                                                                                |
| `keeper(opts)`              | The hot reload state keeper                                                                                                                                                                        |

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
swiftc names the method and its signature. To send an event, call the generated
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
on the main thread and return at once.

For slow work, such as a model or a network call, make the op async:

```ts
"ai.steps": op(t.struct("AiStepsArgs", { text: t.string }), t.list(t.string), {
  async: true,
}),
```

```swift
func aiSteps(_ a: AiStepsArgs) async throws -> [String] { … }
```

The shell checks the args at once, then runs the method on the main
actor. The page's `native.call` resolves when it returns, or rejects with
the error it throws. `todo-bar` uses one for Apple Intelligence.
