# native-op

An op of your own, in Swift. It's hello plus a `native/` folder:

- `native/bridge.ts` declares `sound.play`: its args and its result.
- `native/Sources/Sound.swift` handles it.
- `native/page.d.ts` types `native.call("sound.play", …)` in the page.

A menu item calls it too. Menus are in `package.json` under `"steambun"`.

```sh
bun app   # build and open build/NativeOp.app
```

Delete `native/` and the app builds with the stock shell.
