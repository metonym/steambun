// The test link: steambun/test (src/test.ts) drives the whole app through it.
//
//   harness → shell  {"id","op","args"}                 a TEST_OPS call (steambun/bridge.ts)
//   shell → harness  {"id","ok":true,"result"}           its reply
//                    {"id","ok":false,"error"}
//
// The harness serves a WebSocket and passes its URL in STEAMBUN_TEST_WS;
// the shell connects out to it. With no URL, none of this runs. Input goes
// through NSApp.sendEvent, so it takes a real key's path: menus first.

import AppKit
import Carbon.HIToolbox
import WebKit

/// A test run stays out of the way: no Dock icon, no focus taken from the
/// app you're in, and a window you can't see or click. It still draws, so
/// frames, focus and input work as in a shown window.
/// STEAMBUN_TEST_SHOW=1 shows it, to watch a test run. STEAMBUN_QUIET=1
/// runs quiet with no harness, as the benchmarks do.
let quietTest =
  (opt("STEAMBUN_TEST_WS") != nil || opt("STEAMBUN_QUIET") == "1")
  && opt("STEAMBUN_TEST_SHOW") != "1"

final class Tests {
  let link = ShellLink(token: "", name: "test harness")
  private unowned let app: Shell

  init(app: Shell) {
    self.app = app
    link.onMessage = { [weak self] m in self?.handle(m) }
  }

  private func handle(_ m: [String: Any]) {
    guard let id = m["id"] else { return }
    let reply: (Result<Any?, Error>) -> Void = { [link] r in
      switch r {
      case .success(let v): link.send(["id": id, "ok": true, "result": v ?? NSNull()])
      case .failure(let e): link.send(["id": id, "ok": false, "error": e.localizedDescription])
      }
    }
    guard let name = m["op"] as? String, let op = TestOp(rawValue: name) else {
      return reply(.failure(BridgeError("unknown test op \(m["op"] ?? "nil")")))
    }
    do { try run(op, m["args"], reply) } catch { reply(.failure(error)) }
  }

  private func run(_ op: TestOp, _ args: Any?, _ reply: @escaping (Result<Any?, Error>) -> Void) throws {
    switch op {
    case .eval:
      let a = try bridgeDecode(TestEvalArgs.self, args)
      app.web.callAsyncJavaScript(a.js, arguments: [:], in: nil, in: .page) { r in
        reply(r.map { v in jsonSafe(v) as Any? })
      }
    case .key:
      let a = try bridgeDecode(TestKeyArgs.self, args)
      guard let (chars, mods) = menuKey(a.chord), let code = keyCode(a.chord) else {
        throw BridgeError("can't press \(a.chord)")
      }
      press(chars, code, mods)
      reply(.success(nil))
    case .type:
      try type(try bridgeDecode(TestTypeArgs.self, args).text)
      reply(.success(nil))
    case .paste:
      let a = try bridgeDecode(TestPasteArgs.self, args)
      let pb = NSPasteboard.general
      let before = pb.string(forType: .string)
      pb.clearContents()
      pb.setString(a.text, forType: .string)
      // The Edit menu's Paste goes to the first responder. While the
      // screen is locked the window can't be key, so aim at the web view.
      let to: Any? = app.window.isKeyWindow ? nil : app.web
      NSApp.sendAction(#selector(NSText.paste(_:)), to: to, from: nil)
      // Give the person their clipboard back once the page has read it.
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
        pb.clearContents()
        if let before { pb.setString(before, forType: .string) }
      }
      reply(.success(nil))
    case .menu:
      let a = try bridgeDecode(TestMenuArgs.self, args)
      guard let item = app.commandItems[a.id] else { throw BridgeError("no menu command \(a.id)") }
      app.runCommand(item)
      reply(.success(nil))
    case .menuKey:
      let a = try bridgeDecode(TestMenuKeyArgs.self, args)
      guard let item = app.commandItems[a.id] else { throw BridgeError("no menu command \(a.id)") }
      let m = item.keyEquivalentModifierMask
      let sym = [(NSEvent.ModifierFlags.control, "⌃"), (.option, "⌥"), (.shift, "⇧"), (.command, "⌘")]
        .filter { m.contains($0.0) }.map(\.1).joined()
      reply(.success(item.keyEquivalent.isEmpty ? "" : sym + item.keyEquivalent))
    case .system:
      let a = try bridgeDecode(TestSystemArgs.self, args)
      app.system.fake(asleep: a.asleep, online: a.online, lowPower: a.lowPower)
      reply(.success(nil))
    case .activate:
      if Config.menuBar { app.showPanel() }
      if !quietTest { NSApp.activate(ignoringOtherApps: true) }
      app.window.orderFrontRegardless()
      app.window.makeKey()
      app.window.makeFirstResponder(app.web)
      reply(.success(nil))
    case .click:
      let a = try bridgeDecode(TestClickArgs.self, args)
      click(a.x, a.y, a.count ?? 1, a.mods ?? [])
      // Reply once the page has run its handlers for the click.
      app.web.evaluateJavaScript("0") { _, _ in reply(.success(nil)) }
    case .screenshot:
      app.web.takeSnapshot(with: nil) { img, err in
        guard let img, let tiff = img.tiffRepresentation,
          let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:])
        else { return reply(.failure(err ?? BridgeError("snapshot failed"))) }
        reply(.success(png.base64EncodedString()))
      }
    case .state:
      let icon = NSApp.applicationIconImage
      var panes: [String: TestPane] = [:]
      for (id, p) in app.pages.panes {
        let f = p.web.frame
        panes[id] = TestPane(
          hidden: p.web.isHidden, x: f.minX, y: f.minY, w: f.width, h: f.height)
      }
      let s = TestState(
        drags: app.drags,
        minW: app.window.contentMinSize.width, minH: app.window.contentMinSize.height,
        iconPx: icon?.representations.first?.pixelsWide ?? 0,
        app: app.appTestState(),
        focus: focusOwner(),
        screens: NSScreen.screens.count,
        menuBar: (app.statusItem?.button?.title ?? "").trimmingCharacters(in: .whitespaces),
        panel: Config.menuBar && app.window.isVisible,
        url: app.web.url?.absoluteString ?? "", panes: panes)
      reply(.success(try bridgeEncode(s)))
    case .prune:
      let a = try bridgeDecode(TestPruneArgs.self, args)
      let m = NSMenu()
      for id in a.items {
        let it = id.isEmpty ? NSMenuItem.separator() : NSMenuItem(title: id, action: nil, keyEquivalent: "")
        if !id.isEmpty { it.identifier = NSUserInterfaceItemIdentifier("WKMenuItemIdentifier" + id) }
        m.addItem(it)
      }
      AppWebView.prune(m)
      reply(.success(m.items.map { $0.isSeparatorItem ? "" : $0.title }))
    case .screen:
      let a = try bridgeDecode(TestScreenArgs.self, args)
      let all = NSScreen.screens
      guard all.indices.contains(a.index) else { throw BridgeError("no screen \(a.index)") }
      let s = all[a.index]
      app.window.setFrameOrigin(NSPoint(x: s.visibleFrame.minX + 40, y: s.visibleFrame.minY + 40))
      reply(.success(try bridgeEncode(TestScreen(name: s.localizedName, maxFps: s.maximumFramesPerSecond))))
    }
  }

  /// Whether a menu item owns this chord, and if so, run it. AppKit's own
  /// match is not reliable for an inactive app, so the app's commands are
  /// matched here, by key and modifiers, as AppKit would.
  private func menuTakes(_ e: NSEvent) -> Bool {
    let key = (e.charactersIgnoringModifiers ?? "").lowercased()
    let mods = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
      .intersection([.command, .control, .option, .shift])
    for item in app.commandItems.values where item.isEnabled
      && item.keyEquivalent.lowercased() == key
      && item.keyEquivalentModifierMask.intersection([.command, .control, .option, .shift]) == mods
    {
      app.runCommand(item)
      return true
    }
    return NSApp.mainMenu?.performKeyEquivalent(with: e) == true
  }

  /// A key down and up, sent through the app as if typed.
  private func press(_ chars: String, _ code: UInt16, _ mods: NSEvent.ModifierFlags) {
    // A real ⌘⇧H carries "H", even in charactersIgnoringModifiers, and
    // menus match on that.
    let chars = mods.contains(.shift) && chars.count == 1 ? chars.uppercased() : chars
    for type in [NSEvent.EventType.keyDown, .keyUp] {
      let e = NSEvent.keyEvent(
        with: type, location: .zero, modifierFlags: mods,
        timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: app.window.windowNumber, context: nil, characters: chars,
        charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code)!
      // AppKit tries menu key equivalents only while the app is active, and
      // a test app runs behind the terminal. So ask the menus first, as a
      // real key would; if one takes the key, the page never sees it.
      if type == .keyDown, !mods.isDisjoint(with: [.command, .control, .option]),
        menuTakes(e)
      {
        return
      }
      NSApp.sendEvent(e)
    }
  }

  /// Type text as real key events. Pages read event.code, so each key
  /// needs its real key code.
  private func type(_ text: String) throws {
    let shifted: [Character: Character] = [
      "_": "-", "$": "4", "(": "9", ")": "0", "*": "8", "!": "1", "?": "/", ":": ";",
    ]
    for ch in text {
      var base = Character(ch.lowercased())
      var mods: NSEvent.ModifierFlags = ch.isUppercase ? .shift : []
      if let b = shifted[ch] { base = b; mods = .shift }
      let name = base == "\r" || base == "\n" ? "Enter" : String(base)
      guard let code = keyCode(name) else { throw BridgeError("can't type \(ch.debugDescription)") }
      press(name == "Enter" ? "\r" : String(ch), code, mods)
    }
  }

  /// Mouse down and up at page point (x, y), as AppKit events, so the page
  /// sees a trusted click. Hit-testing picks the view, as a real click's
  /// does; a view over the page (a pane, a drag region) gets it instead.
  /// They go to that view, not through the window: NSWindow drops clicks
  /// in an inactive app, and a test run's app is never active.
  private func click(_ x: Double, _ y: Double, _ count: Int, _ mods: [String]) {
    let web = app.web!
    var flags: NSEvent.ModifierFlags = []
    for m in mods {
      switch m {
      case "shift": flags.insert(.shift)
      case "ctrl": flags.insert(.control)
      case "alt": flags.insert(.option)
      case "meta": flags.insert(.command)
      default: break
      }
    }
    let z = web.pageZoom
    let p = NSPoint(x: x * z, y: web.isFlipped ? y * z : web.bounds.height - y * z)
    let at = web.convert(p, to: nil)
    let root = app.window.contentView!
    let hit = root.superview.flatMap { root.hitTest($0.convert(at, from: nil)) }
    let target = hit.map { $0.isDescendant(of: web) ? web : $0 } ?? web
    for (type, i) in [(NSEvent.EventType.leftMouseDown, 0), (.leftMouseUp, 1)] {
      guard
        let e = NSEvent.mouseEvent(
          with: type, location: at, modifierFlags: flags,
          timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: app.window.windowNumber,
          context: nil, eventNumber: i, clickCount: count, pressure: i == 0 ? 1 : 0)
      else { continue }
      if type == .leftMouseDown { target.mouseDown(with: e) } else { target.mouseUp(with: e) }
    }
  }

  private func focusOwner() -> String {
    guard let v = app.window.firstResponder as? NSView else {
      return String(describing: Swift.type(of: app.window.firstResponder as Any))
    }
    if v.isDescendant(of: app.web) { return "page" }
    for (id, p) in app.pages.panes where v.isDescendant(of: p.web) { return "pane:\(id)" }
    return String(describing: Swift.type(of: v))
  }
}

/// The US-layout key code for a chord's key: "mod+k" → kVK_ANSI_K.
func keyCode(_ chord: String) -> UInt16? {
  let key = chord.hasSuffix("++") ? "+" : (chord.components(separatedBy: "+").last ?? "")
  let codes: [String: Int] = [
    "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E,
    "f": kVK_ANSI_F, "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J,
    "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O,
    "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T,
    "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X, "y": kVK_ANSI_Y,
    "z": kVK_ANSI_Z, "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3,
    "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8,
    "9": kVK_ANSI_9, ";": kVK_ANSI_Semicolon, "-": kVK_ANSI_Minus, ".": kVK_ANSI_Period,
    "/": kVK_ANSI_Slash, ",": kVK_ANSI_Comma, "`": kVK_ANSI_Grave, "[": kVK_ANSI_LeftBracket,
    "]": kVK_ANSI_RightBracket, "=": kVK_ANSI_Equal, "'": kVK_ANSI_Quote, " ": kVK_Space,
    "Space": kVK_Space, "Enter": kVK_Return, "Escape": kVK_Escape, "Backspace": kVK_Delete,
    "Delete": kVK_ForwardDelete, "Tab": kVK_Tab, "ArrowUp": kVK_UpArrow,
    "ArrowDown": kVK_DownArrow, "ArrowLeft": kVK_LeftArrow, "ArrowRight": kVK_RightArrow,
  ]
  return (codes[key] ?? codes[key.lowercased()]).map { UInt16($0) }
}

/// WebKit hands back NSNumber, NSString, arrays, dictionaries and NSNull,
/// plus a few types JSON can't hold. Turn those into strings.
private func jsonSafe(_ v: Any) -> Any {
  switch v {
  case is NSNull, is String, is NSNumber: return v
  case let a as [Any]: return a.map(jsonSafe)
  case let d as [String: Any]: return d.mapValues(jsonSafe)
  default: return "\(v)"
  }

}
