// Native browser pages: real WKWebViews that the core drives and the app's
// browser pane shows. See steambun/core/link.ts for the other end.
//
//   core → shell  {"id","op","page","args"}      over a WebSocket to /_steambun/ws
//   shell → core  {"id","ok","result"|"error"}   the reply
//                 {"ev":"meta"|"log"|"error","page",...}
//
// The page (app/Browser.svelte) says where its pane is with the
// `pane.place` bridge op (steambun/bridge.ts). A page with no
// rect stays alive but hidden: agents can drive it with no pane open.

import AppKit
import Carbon.HIToolbox
import WebKit

/// The WebSocket to the core. Reconnects until stopped, since the core may
/// restart under us.
final class ShellLink: NSObject, URLSessionWebSocketDelegate {
  var onMessage: (([String: Any]) -> Void)?
  /// Runs each time the socket opens, first or after a reconnect.
  var onOpen: (() -> Void)?
  private var task: URLSessionWebSocketTask?
  private var session: URLSession!
  private var url: URL?
  private let token: String
  private let name: String
  private var stopped = false

  init(token: String, name: String = "core") {
    self.token = token
    self.name = name
    super.init()
    session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
  }

  func connect(port: UInt16) {
    connect(url: URL(string: "ws://127.0.0.1:\(port)/_steambun/ws")!)
  }

  func connect(url: URL) {
    self.url = url
    stopped = false
    open()
  }

  func stop() {
    stopped = true
    task?.cancel(with: .goingAway, reason: nil)
  }

  private func open() {
    guard let url, !stopped else { return }
    var req = URLRequest(url: url)
    if !token.isEmpty { req.setValue(token, forHTTPHeaderField: "x-steambun-token") }
    let t = session.webSocketTask(with: req)
    t.maximumMessageSize = 64 << 20
    task = t
    t.resume()
    receive(t)
  }

  private func receive(_ t: URLSessionWebSocketTask) {
    t.receive { [weak self] r in
      guard let self, t === self.task else { return }
      switch r {
      case .success(.string(let s)):
        if let d = s.data(using: .utf8),
          let m = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
        {
          self.onMessage?(m)
        }
        self.receive(t)
      case .success: self.receive(t)
      case .failure:
        // The core went away or isn't up yet: try again shortly.
        self.task = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.open() }
      }
    }
  }

  func urlSession(
    _ s: URLSession, webSocketTask t: URLSessionWebSocketTask, didOpenWithProtocol p: String?
  ) {
    log("link: connected to \(name)")
    onOpen?()
  }

  func send(_ m: [String: Any]) {
    guard let task, let d = try? JSONSerialization.data(withJSONObject: m),
      let s = String(data: d, encoding: .utf8)
    else { return }
    task.send(.string(s)) { _ in }
  }
}

/// Holds the page views. Pane rects are in the main page's CSS pixels with
/// the origin at the top left, so the layer is flipped.
final class PaneLayer: NSView {
  override var isFlipped: Bool { true }
  // Clicks outside a page fall through to the app below.
  override func hitTest(_ p: NSPoint) -> NSView? {
    let v = super.hitTest(p)
    return v === self ? nil : v
  }
}

final class Pages {
  let layer = PaneLayer()
  let link: ShellLink
  weak var main: WKWebView?
  /// A menu bar app's title and icon, set by the core (MenuBar.swift).
  var onMenuBar: ((MenuBarSet) -> Void)?
  private(set) var panes: [String: Pane] = [:]
  private var probe = ""

  init(token: String) {
    link = ShellLink(token: token)
    layer.autoresizingMask = [.width, .height]
    link.onMessage = { [weak self] m in self?.handle(m) }
  }

  /// Where the page wants pane `id`; nil hides it.
  func place(_ id: String, _ rect: BridgeRect?) {
    let p = pane(id)
    guard let r = rect, r.w > 0, r.h > 0 else { return hide(p) }
    let z = main?.pageZoom ?? 1
    p.web.frame = NSRect(x: r.x * z, y: r.y * z, width: r.w * z, height: r.h * z)
    p.web.isHidden = false
  }

  /// The main page left: its panes go with it until it places them again.
  func hideAll() {
    for p in panes.values { hide(p) }
  }

  /// A hidden view keeps key focus. Hand it to the main page, or a dialog
  /// opened over the pane (⌘/ from the menu) would never see its Escape.
  /// Check before hiding: AppKit gives a hidden view's focus to the window
  /// itself, and then keys go nowhere.
  private func hide(_ p: Pane) {
    if let w = p.web.window, let f = w.firstResponder as? NSView, f.isDescendant(of: p.web) {
      w.makeFirstResponder(main)
    }
    p.web.isHidden = true
  }

  private func pane(_ id: String) -> Pane {
    if let p = panes[id] { return p }
    let p = Pane(id: id, probe: probe, link: link)
    p.web.frame = NSRect(x: 0, y: 0, width: 1024, height: 768)
    p.web.isHidden = true
    layer.addSubview(p.web)
    panes[id] = p
    return p
  }

  private func handle(_ m: [String: Any]) {
    guard let id = m["id"] as? Int, let name = m["op"] as? String,
      let page = m["page"] as? String
    else { return }
    let args = m["args"] as? [String: Any] ?? [:]
    let reply: (Result<Any?, Error>) -> Void = { [link] r in
      switch r {
      case .success(let v): link.send(["id": id, "ok": true, "result": v ?? NSNull()])
      case .failure(let e): link.send(["id": id, "ok": false, "error": e.localizedDescription])
      }
    }
    guard let op = CoreOp(rawValue: name) else {
      return reply(.failure(PageError("unknown op \(name)")))
    }
    if op == .menuBar {
      guard let set = onMenuBar else { return reply(.failure(PageError("not a menu bar app"))) }
      set(MenuBarSet(title: args["title"] as? String, icon: args["icon"] as? String))
      return reply(.success(nil))
    }
    if op == .open {
      if let s = args["probe"] as? String { probe = s }
      let p = pane(page)
      // The app may have placed the pane before the core opened it.
      p.install(probe)
      p.sendMeta()
      return reply(.success(nil))
    }
    if op == .close {
      panes.removeValue(forKey: page)?.close()
      return reply(.success(nil))
    }
    guard let p = panes[page] else { return reply(.failure(PageError("no page \(page)"))) }
    p.run(op, args, reply)
  }
}

struct PageError: LocalizedError {
  let msg: String
  init(_ m: String) { msg = m }
  var errorDescription: String? { msg }
}

final class Pane: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
  let id: String
  let web: WKWebView
  private let link: ShellLink
  private var navs: [ObjectIdentifier: (Result<Any?, Error>) -> Void] = [:]
  private var watches: [NSKeyValueObservation] = []
  private var logs: [[String: Any]] = []
  private var metaQueued = false
  private var probed = false

  init(id: String, probe: String, link: ShellLink) {
    self.id = id
    self.link = link
    let cfg = WKWebViewConfiguration()
    // One profile for every page: logins carry across panes and restarts.
    cfg.websiteDataStore = webStore
    let ucc = WKUserContentController()
    cfg.userContentController = ucc
    cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
    web = WKWebView(frame: .zero, configuration: cfg)
    super.init()
    ucc.add(WeakHandler(self), name: "steambunLog")
    install(probe)
    web.navigationDelegate = self
    web.uiDelegate = self
    web.isInspectable = true
    web.allowsBackForwardNavigationGestures = true
    web.allowsMagnification = true
    watches = [
      web.observe(\.url) { [weak self] _, _ in self?.queueMeta() },
      web.observe(\.title) { [weak self] _, _ in self?.queueMeta() },
      web.observe(\.isLoading) { [weak self] _, _ in self?.queueMeta() },
    ]
  }

  /// The console probe, before any page script, from the next load on.
  func install(_ probe: String) {
    guard !probed, !probe.isEmpty else { return }
    probed = true
    web.configuration.userContentController.addUserScript(
      WKUserScript(source: probe, injectionTime: .atDocumentStart, forMainFrameOnly: true))
  }

  func close() {
    watches = []
    web.stopLoading()
    web.configuration.userContentController.removeScriptMessageHandler(forName: "steambunLog")
    web.removeFromSuperview()
    for r in navs.values { r(.failure(PageError("page closed"))) }
    navs = [:]
  }

  // MARK: Events to the core

  private func queueMeta() {
    guard !metaQueued else { return }
    metaQueued = true
    DispatchQueue.main.async { self.sendMeta() }
  }
  func sendMeta() {
    metaQueued = false
    link.send([
      "ev": "meta", "page": id, "url": web.url?.absoluteString ?? "",
      "title": web.title ?? "", "loading": web.isLoading,
    ])
  }

  func userContentController(_ u: WKUserContentController, didReceive m: WKScriptMessage) {
    guard let e = m.body as? [String: Any] else { return }
    // A noisy page logs thousands of lines a second: send them in batches.
    if logs.isEmpty {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
        self.link.send(["ev": "log", "page": self.id, "entries": self.logs])
        self.logs = []
      }
    }
    if logs.count < 1000 { logs.append(e) }
  }

  // MARK: Ops from the core

  func run(_ op: CoreOp, _ a: [String: Any], _ reply: @escaping (Result<Any?, Error>) -> Void) {
    switch op {
    case .open, .close, .menuBar: reply(.success(nil))  // Pages handles these
    case .navigate:
      guard let s = a["url"] as? String, let u = URL(string: s) else {
        return reply(.failure(PageError("bad url")))
      }
      track(web.load(URLRequest(url: u)), reply)
    case .back: track(web.goBack(), reply)
    case .forward: track(web.goForward(), reply)
    case .reload: track(web.reload(), reply)
    case .eval:
      let expr = a["expr"] as? String ?? "undefined"
      // The same contract as Bun.WebView.evaluate: an expression, awaited,
      // returned as JSON.
      web.callAsyncJavaScript(
        "const v = await (\(expr)); return v === undefined ? undefined : JSON.stringify(v);",
        arguments: [:], in: nil, in: .page
      ) { r in
        switch r {
        case .success(let v):
          if let s = v as? String, let d = s.data(using: .utf8) {
            reply(.success(try? JSONSerialization.jsonObject(with: d, options: .fragmentsAllowed)))
          } else {
            reply(.success(nil))
          }
        case .failure(let e): reply(.failure(e))
        }
      }
    case .screenshot:
      let png = (a["format"] as? String) != "jpeg"
      let q = (a["quality"] as? Double ?? 80) / 100
      web.takeSnapshot(with: nil) { img, err in
        guard let img, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
          let data = png
            ? rep.representation(using: .png, properties: [:])
            : rep.representation(using: .jpeg, properties: [.compressionFactor: q])
        else { return reply(.failure(err ?? PageError("snapshot failed"))) }
        reply(.success(data.base64EncodedString()))
      }
    case .click:
      let x = a["x"] as? Double ?? 0, y = a["y"] as? Double ?? 0
      let count = max(1, a["count"] as? Int ?? 1)
      withFocus {
        click(x, y, count, flags(a["mods"]))
      }
      barrier(reply)
    case .type:
      let text = a["text"] as? String ?? ""
      withFocus { (web as NSResponder).insertText(text) }
      barrier(reply)
    case .press:
      guard let k = Pane.keys[a["key"] as? String ?? ""] ?? Pane.char(a["key"] as? String ?? "")
      else { return reply(.failure(PageError("unknown key"))) }
      withFocus { press(k, flags(a["mods"])) }
      barrier(reply)
    case .scroll:
      let dx = a["dx"] as? Double ?? 0, dy = a["dy"] as? Double ?? 0
      web.evaluateJavaScript("scrollBy(\(dx), \(dy))") { _, _ in reply(.success(nil)) }
    case .resize:
      reply(.failure(PageError("a native page takes its size from the pane")))
    }
  }

  /// Reply when this navigation ends. No navigation (nothing to go back
  /// to) replies at once.
  private func track(_ n: WKNavigation?, _ reply: @escaping (Result<Any?, Error>) -> Void) {
    guard let n else { return reply(.success(nil)) }
    navs[ObjectIdentifier(n)] = reply
  }
  private func settle(_ n: WKNavigation?, _ r: Result<Any?, Error>) {
    guard let n, let f = navs.removeValue(forKey: ObjectIdentifier(n)) else { return }
    f(r)
  }

  /// Input reaches WebKit as events in order; an evaluate after them
  /// returns once the page has handled them.
  private func barrier(_ reply: @escaping (Result<Any?, Error>) -> Void) {
    web.evaluateJavaScript("0") { _, _ in reply(.success(nil)) }
  }

  /// Keys need the page focused. Give it focus for the input, then hand it
  /// back if the user was elsewhere in the app.
  private func withFocus(_ f: () -> Void) {
    guard let w = web.window else { return f() }
    let prev = w.firstResponder
    let mine = (prev as? NSView)?.isDescendant(of: web) ?? false
    if !mine { w.makeFirstResponder(web) }
    f()
    if !mine, let prev, !(prev is NSWindow) {
      // After the events: WebKit sends them to the page in order.
      DispatchQueue.main.async { w.makeFirstResponder(prev) }
    }
  }

  private func flags(_ m: Any?) -> NSEvent.ModifierFlags {
    var f: NSEvent.ModifierFlags = []
    for s in m as? [String] ?? [] {
      switch s {
      case "shift": f.insert(.shift)
      case "ctrl": f.insert(.control)
      case "alt": f.insert(.option)
      case "meta": f.insert(.command)
      default: break
      }
    }
    return f
  }

  private func click(_ x: Double, _ y: Double, _ count: Int, _ mods: NSEvent.ModifierFlags) {
    guard let w = web.window else { return }
    let z = web.pageZoom
    let p = NSPoint(x: x * z, y: web.isFlipped ? y * z : web.bounds.height - y * z)
    let at = web.convert(p, to: nil)
    for (type, i) in [(NSEvent.EventType.leftMouseDown, 0), (.leftMouseUp, 1)] {
      guard
        let e = NSEvent.mouseEvent(
          with: type, location: at, modifierFlags: mods,
          timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: w.windowNumber,
          context: nil, eventNumber: i, clickCount: count, pressure: i == 0 ? 1 : 0)
      else { continue }
      if type == .leftMouseDown { web.mouseDown(with: e) } else { web.mouseUp(with: e) }
    }
  }

  typealias Key = (code: Int, chars: String)
  static let keys: [String: Key] = [
    "Enter": (kVK_Return, "\r"), "Tab": (kVK_Tab, "\t"), "Backspace": (kVK_Delete, "\u{7f}"),
    "Delete": (kVK_ForwardDelete, String(UnicodeScalar(NSDeleteFunctionKey)!)),
    "Escape": (kVK_Escape, "\u{1b}"), "Space": (kVK_Space, " "),
    "ArrowLeft": (kVK_LeftArrow, String(UnicodeScalar(NSLeftArrowFunctionKey)!)),
    "ArrowRight": (kVK_RightArrow, String(UnicodeScalar(NSRightArrowFunctionKey)!)),
    "ArrowUp": (kVK_UpArrow, String(UnicodeScalar(NSUpArrowFunctionKey)!)),
    "ArrowDown": (kVK_DownArrow, String(UnicodeScalar(NSDownArrowFunctionKey)!)),
    "Home": (kVK_Home, String(UnicodeScalar(NSHomeFunctionKey)!)),
    "End": (kVK_End, String(UnicodeScalar(NSEndFunctionKey)!)),
    "PageUp": (kVK_PageUp, String(UnicodeScalar(NSPageUpFunctionKey)!)),
    "PageDown": (kVK_PageDown, String(UnicodeScalar(NSPageDownFunctionKey)!)),
  ]
  static let letters: [Character: Int] = [
    "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E,
    "f": kVK_ANSI_F, "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J,
    "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O,
    "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T,
    "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X, "y": kVK_ANSI_Y,
    "z": kVK_ANSI_Z, "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3,
    "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8,
    "9": kVK_ANSI_9,
  ]
  static func char(_ s: String) -> Key? {
    guard s.count == 1, let c = s.lowercased().first, let code = letters[c] else { return nil }
    return (code, s)
  }

  private func press(_ k: Key, _ mods: NSEvent.ModifierFlags) {
    guard let w = web.window else { return }
    for type in [NSEvent.EventType.keyDown, .keyUp] {
      guard
        let e = NSEvent.keyEvent(
          with: type, location: .zero, modifierFlags: mods,
          timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: w.windowNumber,
          context: nil, characters: k.chars, charactersIgnoringModifiers: k.chars,
          isARepeat: false, keyCode: UInt16(k.code))
      else { continue }
      if type == .keyDown {
        // ⌘ chords (select all, copy) go through key equivalents first.
        if mods.contains(.command), web.performKeyEquivalent(with: e) { continue }
        web.keyDown(with: e)
      } else {
        web.keyUp(with: e)
      }
    }
  }

  // MARK: Navigation

  func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
    // Meta first: the caller's reply reports the new title.
    sendMeta()
    settle(n, .success(nil))
  }
  func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { failed(n, e) }
  func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) {
    failed(n, e)
  }
  private func failed(_ n: WKNavigation?, _ e: Error) {
    // A newer load replaced this one: not a failure the caller cares about.
    if (e as NSError).code == NSURLErrorCancelled { return settle(n, .success(nil)) }
    sendMeta()
    link.send(["ev": "error", "page": id, "message": e.localizedDescription])
    settle(n, .failure(e))
  }
  func webViewWebContentProcessDidTerminate(_ w: WKWebView) {
    link.send(["ev": "error", "page": id, "message": "The page crashed; reloading."])
    w.reload()
  }

  // MARK: Page UI: links that open windows, dialogs, file pickers

  func webView(
    _ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction,
    windowFeatures f: WKWindowFeatures
  ) -> WKWebView? {
    // One pane, one page: open "new window" links in place.
    w.load(a.request)
    return nil
  }

  func webView(
    _ w: WKWebView, runJavaScriptAlertPanelWithMessage msg: String, initiatedByFrame f: WKFrameInfo,
    completionHandler done: @escaping () -> Void
  ) {
    guard let win = w.window, !w.isHidden else { return done() }
    let a = NSAlert()
    a.messageText = msg
    a.beginSheetModal(for: win) { _ in done() }
  }

  func webView(
    _ w: WKWebView, runJavaScriptConfirmPanelWithMessage msg: String, initiatedByFrame f: WKFrameInfo,
    completionHandler done: @escaping (Bool) -> Void
  ) {
    guard let win = w.window, !w.isHidden else { return done(false) }
    let a = NSAlert()
    a.messageText = msg
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Cancel")
    a.beginSheetModal(for: win) { r in done(r == .alertFirstButtonReturn) }
  }

  func webView(
    _ w: WKWebView, runJavaScriptTextInputPanelWithPrompt p: String, defaultText d: String?,
    initiatedByFrame f: WKFrameInfo, completionHandler done: @escaping (String?) -> Void
  ) {
    guard let win = w.window, !w.isHidden else { return done(nil) }
    let a = NSAlert()
    a.messageText = p
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
    field.stringValue = d ?? ""
    a.accessoryView = field
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Cancel")
    a.beginSheetModal(for: win) { r in done(r == .alertFirstButtonReturn ? field.stringValue : nil) }
  }

  func webView(
    _ w: WKWebView, runOpenPanelWith p: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo,
    completionHandler done: @escaping ([URL]?) -> Void
  ) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = p.allowsMultipleSelection
    panel.canChooseDirectories = p.allowsDirectories
    guard let win = w.window else { return done(nil) }
    panel.beginSheetModal(for: win) { r in done(r == .OK ? panel.urls : nil) }
  }
}

/// WKUserContentController keeps its handlers alive; this breaks the cycle.
final class WeakHandler: NSObject, WKScriptMessageHandler {
  weak var target: WKScriptMessageHandler?
  init(_ t: WKScriptMessageHandler) { target = t }
  func userContentController(_ u: WKUserContentController, didReceive m: WKScriptMessage) {
    target?.userContentController(u, didReceive: m)
  }
}
