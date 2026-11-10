# Testing

`steambun/test` starts your app and drives it from `bun test`. It works
with or without a core. Tests are plain TypeScript, run hidden, and take
about as long as unit tests:

| Suite                                | Tests | Mac app | Tab   |
| ------------------------------------ | ----- | ------- | ----- |
| `examples/hello`                     | 1     | 0.4 s   | 0.3 s |
| `examples/core` (React page, a core) | 3     | 1.0 s   | 0.5 s |
| `examples/todo-bar` (menu bar app)   | 4     | 0.7 s   | 0.4 s |
| All five examples                    | 13    | 1.2 s   | 0.7 s |

Times are the whole run, launch included, on an M-series Mac, with the
app run from source. Test files run at once. With `--serial`, the
examples take 3.2 s.

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

**A test gets 30 s, not bun's 5 s.** A relaunch on a slow CI runner can
take 5 s alone. `waitFor` still gives up after 5 s, so a stuck wait
fails with its own message, not a test timeout. Pass a number as the
third argument to `test` to set your own limit.

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
