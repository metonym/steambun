# The command line

Run `steambun` in the app's folder, where `package.json` lives. The
examples' `package.json` scripts call it for you: `bun run dev`,
`bun run app`, and so on.

```sh
steambun <command> [options] [-- args]
```

| Command                        | What it does                                                 |
| ------------------------------ | ------------------------------------------------------------ |
| [`dev`](#steambun-dev)         | The page, or the core, from source with hot reload.          |
| [`build`](#steambun-build)     | Compiles the core with its page, or bundles the page alone.  |
| [`app`](#steambun-app)         | Builds, then makes and signs `build/<Name>.app`.             |
| [`test`](#steambun-test)       | Runs the `*.e2e.ts` tests in the Mac app, a tab, or both.    |
| [`gen`](#steambun-gen)         | Writes the generated Swift, or checks that it's current.     |
| [`check`](#steambun-check)     | Fails if the page imports Bun, or the core imports the page. |
| [`release`](#steambun-release) | Makes the update key, or writes a signed update feed.        |

Options for every command:

| Option            | What it does                                                          |
| ----------------- | --------------------------------------------------------------------- |
| `-h`, `--help`    | Prints help on stdout. `steambun <command> --help` shows one command. |
| `-v`, `--version` | Prints steambun's version on stdout.                                  |
| `--verbose`       | Prints every log line: timings, links, the shell's internals, stacks. |

Options can come before or after the command. `--port 3000` and
`--port=3000` mean the same. Arguments after `--` go to the core (`dev`)
or to `bun test` (`test`).

## steambun dev

Runs the app from source with hot reload. A change to the page or the
core reloads it. Ctrl-C quits.

| Option       | What it does                                                                     |
| ------------ | -------------------------------------------------------------------------------- |
| `--native`   | Runs it in the Mac app. Builds the shell first if it's stale.                    |
| `--home DIR` | The app's data folder. Default: the config's `home`.                             |
| `--port N`   | The port of the core, or of the page with no core. Default: the config's `port`. |
| `-- ARGS`    | Arguments for the core.                                                          |

**In a tab** (the default). Open the URL in a browser:

```sh
$ steambun dev
steambun dev · Hello · the page in a tab, with hot reload · ctrl-c quits
15:33:30 page   serving http://127.0.0.1:24418/
```

With a core, the core serves the page, so the scope is the core's:

```sh
$ steambun dev
steambun dev · Core · the core in a tab, with hot reload · ctrl-c quits
15:33:43 serve  serving http://127.0.0.1:22079/
```

**In the Mac app.** The first run after a Swift change builds the shell:

```sh
$ steambun dev --native
steambun dev · TodoBar · the page in the Mac app, with hot reload · ctrl-c quits
  shell  ../../src/native/Sources/main.swift changed: building it   # only when Swift changed
✓ page   build/page · 21 KB
✓ shell  compiled · 5.8 s
✓ app    build/TodoBar.app · 1.1 MB · signed ad hoc · 5.9 s
  log    build/dev.log (--verbose prints every line here)
15:27:56 page   serving http://127.0.0.1:24941/
```

After that, it starts at once:

```sh
$ steambun dev --native
steambun dev · TodoBar · the page in the Mac app, with hot reload · ctrl-c quits
  log    build/dev.log (--verbose prints every line here)
15:33:56 page   serving http://127.0.0.1:24941/
```

**With `--verbose`**, the lines that `build/dev.log` keeps show in the
terminal too:

```sh
$ steambun dev --native --verbose
steambun dev · Core · the core in the Mac app, with hot reload · ctrl-c quits
  log    build/dev.log
15:34:22 shell  launched
15:34:23 shell  inherited PATH: …                        # the PATH the core gets
15:34:23 shell  core started pid 60102 port 22079
15:34:23 shell  updates off: no feed or key in this build
15:34:23 serve  serving http://127.0.0.1:22079/
15:34:23 shell  core ready
15:34:23 native shell linked                             # the core sees the shell
15:34:23 env    login PATH resolved in 41 ms             # the core reads your login shell's PATH
Bundled page in 15ms: index.html                         # Bun's dev server
15:34:23 shell  didFinish /                              # the page loaded
15:34:23 shell  first paint 16 ms after navigation start
```

You always see errors and a core restart, with or without `--verbose`:

```sh
15:34:35 shell  core exited unexpectedly (status 1)
15:34:35 shell  core started pid 60304 port 22079
```

## steambun build

Runs [`check`](#steambun-check) first, then:

- **No core:** bundles the page to `build/page`.
- **A core:** compiles the core and its page to one binary,
  `build/core/<Name>`. With `bun: "system"` in the config, it bundles
  them to `build/core` as JS instead. See [Trim](#trim).

| Option     | What it does                                                     |
| ---------- | ---------------------------------------------------------------- |
| `--web`    | Bundles the page alone, as a static site in `build/web`.         |
| `--no-aot` | Skips AOT: a faster build, but a bigger core that starts slower. |
| `--json`   | Prints the result as JSON. See [JSON output](#json-output).      |

```sh
$ steambun build                 # no core
✓ page   build/page · 4 KB

$ steambun build                 # a core
✓ core   build/core/Core · 40.2 MB · AOT, trimmed · 770 ms

$ steambun build --no-aot
✓ core   build/core/Core · 118.4 MB · JIT · 40 ms

$ steambun build --web
✓ web    build/web · 4 KB · a static site
```

`--web` makes a site for any static host. See
[The same page on the web](guide.md#the-same-page-on-the-web).

A build error names the file and the place:

```sh
$ steambun build
error: main.ts:2:8: Could not resolve: "./nope.ts"
error: couldn't build the page: 1 error above
```

## steambun app

Runs [`build`](#steambun-build), then makes and signs
`build/<Name>.app`. It compiles the Swift only when a Swift file
changed. Otherwise it reuses the last build from `build/cache`.

| Option   | What it does                                                |
| -------- | ----------------------------------------------------------- |
| `--open` | Opens the app when it's built.                              |
| `--json` | Prints the result as JSON. See [JSON output](#json-output). |

```sh
$ steambun app
✓ page   build/page · 4 KB
✓ shell  reused: no Swift changed        # or "compiled · 5.8 s"
✓ app    build/Hello.app · 960 KB · signed ad hoc · 104 ms

$ steambun app                           # with a core
✓ core   build/core/Core · 40.2 MB · AOT, trimmed · 701 ms
✓ shell  reused: no Swift changed
✓ app    build/Core.app · 40.9 MB · signed ad hoc · 169 ms
```

`app` reads these from the environment:

| Variable                   | What it sets                                                                 |
| -------------------------- | ---------------------------------------------------------------------------- |
| `VERSION`                  | The version users see. Default: `0.0.1`.                                     |
| `BUILD`                    | The build number. It must only go up. Default: the commit count.             |
| `SIGN_ID`                  | A Developer ID to sign with. Default: `-`, which signs ad hoc.               |
| `UPDATE_URL`, `UPDATE_KEY` | The update feed and its public key. Default: the config's.                   |
| `CORE`                     | A core built somewhere else. With it, `app` doesn't build.                   |
| `ENTITLEMENTS`             | `core` (default) or `core-jit`. Only a core built with `--no-aot` needs JIT. |
| `ZSTD`                     | Where libzstd is. The updater links it. Default: Homebrew's.                 |

```sh
VERSION=1.2.0 SIGN_ID="Developer ID Application: You (TEAMID)" steambun app
```

## steambun test

Runs the `*.e2e.ts` tests with `bun test`. It builds the shell first if
it's stale. Test files run at once, one worker each. See
[Testing](testing.md) for the test API.

| Option     | What it does                                                       |
| ---------- | ------------------------------------------------------------------ |
| `--tab`    | Runs in a browser tab, not the Mac app.                            |
| `--both`   | Runs in the Mac app, then in a tab.                                |
| `--serial` | Runs one test file at a time.                                      |
| `-- ARGS`  | Test files, folders, or `bun test` options like `-t` and `--bail`. |

The output is `bun test`'s. With `--both`, a line names each run:

```sh
$ steambun test --both
steambun test · the Mac app
bun test v1.4.4

 3 pass
 0 fail
Ran 3 tests across 1 file. [2.80s]
steambun test · a tab
bun test v1.4.4

 3 pass
 0 fail
Ran 3 tests across 1 file. [565.00ms]
```

```sh
steambun test -- test/menus.e2e.ts       # one file
steambun test --tab -- -t "adds a to-do" # tests whose name matches
```

The exit code is the worst of the runs. A test file must go after `--`:
`steambun test x.e2e.ts` fails with "put it after --".

## steambun gen

Writes the Swift that the bridge and the config generate. `dev`, `app`
and `test` run it for you, so you rarely need it.

| Option    | What it does                                                          |
| --------- | --------------------------------------------------------------------- |
| `--check` | Writes nothing. Fails if the framework's `Bridge.gen.swift` is stale. |
| `--json`  | Prints the result as JSON. See [JSON output](#json-output).           |

```sh
$ steambun gen
✓ gen    wrote the generated Swift

$ steambun gen --check
✓ gen    the generated Swift is current

$ steambun gen --check                   # after an edit to the generator
error: ../../src/native/Sources/Bridge.gen.swift is stale: run steambun gen
```

## steambun check

Fails if code crosses runtimes: the page imports a Bun API, or the core
imports page code. `build` runs it first. See
[Folder structure](guide.md#folder-structure).

| Option   | What it does                                                |
| -------- | ----------------------------------------------------------- |
| `--json` | Prints the result as JSON. See [JSON output](#json-output). |

```sh
$ steambun check
✓ check  the page and the core stay in their runtimes

$ steambun check
error: code crosses runtimes
page (WebKit): db.ts imports bun:sqlite, a Bun API
  via index.html → main.ts → db.ts       # the imports that lead there
```

## steambun release

Makes the update signing key, or writes a signed update feed. See
[Release](guide.md#release).

| Form                                           | What it does                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `steambun release keygen`                      | Writes the key pair to `native/.keys/`. Fails if the key exists.                                     |
| `steambun release NEW.app OUT_DIR [OLD.app …]` | Writes the feed for `NEW.app` to `OUT_DIR`. Each `OLD.app` gets patches, so its users download less. |

```sh
$ steambun release keygen
✓ key    native/.keys/update.key · private: keep it out of git
✓ pub    native/.keys/update.pub · public: the app checks updates with it

$ steambun release build/Notes.app dist/feed old/Notes.app
✓ feed   dist/feed · 1.2.0 · 6 files · blobs 244 KB · patches 18 KB · 166 ms
```

The feed holds zstd blobs, the patches, `latest.json` and its
signature. Upload the folder to the URL in the config's `update.url`. `UPDATE_KEY_FILE` sets a
different place for the private key.

## Output

The CLI writes to stderr, so stdout stays free for data. Help,
`--version` and `--json` go to stdout.

| Line                                    | Means                                              |
| --------------------------------------- | -------------------------------------------------- |
| `✓ app    build/Hello.app · 960 KB · …` | A step finished: what it made, its size, its time. |
| `  log    build/dev.log`                | A fact about the run.                              |
| `15:05:41 page   serving …`             | A log line from the page, the core or the shell.   |
| `! …`                                   | A warning. The run goes on.                        |
| `error: …`                              | The run stopped.                                   |

- Paths are relative to where you ran the command.
- In `dev`, the page, the core and the shell share one log format:
  `HH:MM:SS scope message`.
- By default you see only what needs you: where the app runs, a
  restart, an error. Timings, links and the shell's internals go only to
  `build/dev.log`. `--verbose` prints them in the terminal too.
- Color shows only on a terminal. `NO_COLOR=1` turns it off.
  `FORCE_COLOR=1` turns it on in a pipe.

## For scripts and agents

The CLI is strict, so a typo fails instead of doing the wrong thing. An
unknown command or option exits 2 with one line, and suggests the
closest match:

```sh
$ steambun app --opne
error: unknown option --opne for app (did you mean --open?)
$ steambun dev --json
error: unknown option --json for dev (build, app, gen and check take it)
```

The exit code says what went wrong:

| Code | Meaning                                                                             |
| ---- | ----------------------------------------------------------------------------------- |
| 0    | Done.                                                                               |
| 1    | The command ran and found a problem: `check`, `gen --check`, a test, a build error. |
| 2    | Called wrong, or no app here: a bad option, no `package.json`, a bad config.        |

Run `steambun gen --check && steambun check` before a commit. Both print
one `✓` line when they pass.

### JSON output

`--json` on `build`, `app`, `gen` and `check` prints one JSON object on
stdout when the command ends, and nothing on stderr. The exit codes stay
the same. Every object has `ok`. The rest depends on the command:

| Command              | On success     | On failure                                     |
| -------------------- | -------------- | ---------------------------------------------- |
| `build`, `app`       | `steps`        | `error`, `steps`, and `logs` for a build error |
| `gen`, `gen --check` | `stale: []`    | `stale`: the files to regenerate               |
| `check`              | `problems: []` | `problems`                                     |
| Any, called wrong    |                | `error`, exit 2                                |

A step has `step` (its name) and, when they apply, `path`, `bytes`,
`ms` and `note`. `steps` holds the steps that finished before an error.
A problem has `side` (`page` or `core`), `chain` (the imports, from the
entry to the file) and `what`.

```sh
$ steambun app --json
{"ok":true,"steps":[
  {"step":"page","path":"build/page","bytes":21159},
  {"step":"shell","note":"reused: no Swift changed"},
  {"step":"app","path":"build/TodoBar.app","bytes":1167566,"note":"signed ad hoc","ms":69}]}

$ steambun build --web --json
{"ok":false,"error":"couldn't build the page: 1 error",
 "logs":["m.ts:1:8: Could not resolve: \"./nope.ts\""],"steps":[]}

$ steambun check --json
{"ok":false,"problems":[{"side":"page","chain":["index.html","main.ts","db.ts"],
 "what":"imports bun:sqlite, a Bun API"}]}

$ steambun gen --check --json
{"ok":false,"stale":["../../src/native/Sources/Bridge.gen.swift"]}

$ steambun build --jsno --json
{"ok":false,"error":"unknown option --jsno for build (did you mean --json?)","steps":[]}
```

The real output is one line. The samples above wrap it to fit.

## steambun/tools

`steambun/tools` exports the functions behind the CLI, for your own
build scripts. Each takes the config that `loadConfig` from
`steambun/config` returns, and prints the same `✓` lines.

```ts
import { loadConfig } from "steambun/config";
import { app, build, paths } from "steambun/tools";

const c = await loadConfig(process.cwd());
await build(c, { aot: true });
await app(c, {
  version: "1.2.0",
  sign: "Developer ID Application: You (TEAMID)",
});
console.log(paths(c).app); // /…/build/Notes.app
```

| Function         | What it does                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev(c, opts)`   | `steambun dev`. `opts`: `native`, `home`, `port`, `args`, `env`. Resolves to the exit code.                                                             |
| `build(c, opts)` | `steambun build`. `opts`: `aot` (default `true`), `outfile`.                                                                                            |
| `buildWeb(c)`    | `steambun build --web`.                                                                                                                                 |
| `app(c, opts)`   | `steambun app`, without the build. `opts` are the env vars above: `version`, `build`, `sign`, `updateURL`, `updateKey`, `core`, `entitlements`, `zstd`. |
| `test(c, opts)`  | `steambun test`. `opts`: `backends` (`["native"]`, `["tab"]` or both), `args`, `parallel` (default `true`). Resolves to the worst exit code.            |
| `gen(c, verify)` | `steambun gen`. With `verify`, writes nothing and resolves to the stale files.                                                                          |
| `shellStale(c)`  | Why the built shell is out of date, such as `"no shell yet"`, or `null`.                                                                                |
| `paths(c)`       | Where things go: `app`, `shell`, `core`, `page`, `web`, `gen`, `script`.                                                                                |
| `plugins(c)`     | The UI build plugins from `bunfig.toml`, the same list `dev` uses.                                                                                      |
| `BuildError`     | What a failed build throws. `logs` holds Bun's errors as `file:line:col: message`.                                                                      |

## Trim

With a core, `steambun build` trims Bun APIs that the core never names, which saves
about 12 MB. A call to a removed API throws `ERR_FEATURE_REMOVED` at run
time, and `bun test` can't catch it. After you add a dependency or a new
Bun API, run the built binary once, or check with:

```sh
bun build --compile --aot --trim --explain=trim ./core.ts
```
