# Changelog

## 0.1.0 — 2026-11-09

The first release of steambun: a web page and an optional Bun core in a
native Mac app, about 1 MB without a core.

**Features**

- `steambun dev`, `build`, `app`, `test`, `check`, `gen` and `release`.
- `steambun/core`, `steambun/ui`, `steambun/test`, `steambun/config`,
  `steambun/schema` and `steambun/svelte`.
- Tests drive the real Mac app or a browser tab with one API.
- Async ops: `op(args, result, { async: true })` gives an `async throws`
  Swift method, and the page's call waits for it.
- `toolbar` in the config: a native toolbar with SF Symbol buttons that
  run the page's commands.
- `symbol()` in `steambun/ui`: SF Symbols in the page, as a CSS mask.
- `glass` in the config: Liquid Glass behind the page on macOS 26, a
  blur before.
- A strict CLI: an unknown command or option exits 2 and suggests the
  closest match. Exit codes are 0, 1 (found a problem) and 2 (called
  wrong). `--version`, and `--help` for each command.
- Quieter, clearer output: one line per result with its size and time,
  one log format in `dev`, color only on a terminal. Timings and the
  shell's internals show only with `--verbose`.
- `--json` on `build`, `app`, `gen` and `check`: one JSON object on
  stdout, for scripts and agents.
