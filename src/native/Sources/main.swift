// steambun native shell.
//
// A thin AppKit shell: one window (or a menu bar panel) with a WKWebView.
// With a core, it starts the core as a child process on 127.0.0.1, waits
// for it to answer, then loads the page from it. With no core,
// PageScheme.swift serves the built page from the bundle.

import AppKit
import Carbon.HIToolbox
import UserNotifications
import WebKit

// MARK: - Options and log

/// Options come from the environment or from launch arguments
/// (`open X.app --args -STEAMBUN_HOME /path`), which UserDefaults parses.
func opt(_ key: String) -> String? {
  ProcessInfo.processInfo.environment[key] ?? UserDefaults.standard.string(forKey: key)
}

/// The web data store for the window and its panes: localStorage, cookies,
/// caches. STEAMBUN_STORE (a UUID) gives a run its own store, so a test's
/// data neither leaks into the next test nor into the user's app. The test
/// harness removes it afterwards.
let webStore: WKWebsiteDataStore = {
  if let s = opt("STEAMBUN_STORE"), let id = UUID(uuidString: s) {
    return WKWebsiteDataStore(forIdentifier: id)
  }
  return .default()
}()

let logPath = opt("STEAMBUN_LOG") ?? "/tmp/\(Config.name)-native.log"
let logHandle: FileHandle? = {
  FileManager.default.createFile(atPath: logPath, contents: nil)
  return FileHandle(forWritingAtPath: logPath)
}()

/// STEAMBUN_VERBOSE=1 (`steambun dev --verbose`) prints detail lines too.
let verbose = opt("STEAMBUN_VERBOSE") == "1"
/// Color only on a terminal; NO_COLOR and FORCE_COLOR win (no-color.org).
let useColor: Bool = {
  let e = ProcessInfo.processInfo.environment
  if let f = e["FORCE_COLOR"], f != "0" { return true }
  if let n = e["NO_COLOR"], !n.isEmpty { return false }
  return isatty(2) != 0
}()
private let clock: DateFormatter = {
  let f = DateFormatter()
  f.dateFormat = "HH:mm:ss"
  return f
}()

private func toFile(_ s: String) {
  let line = String(format: "%.3f ", Date().timeIntervalSince1970) + s + "\n"
  logHandle?.seekToEndOfFile()
  logHandle?.write(line.data(using: .utf8)!)
}

private func toTerminal(_ s: String) {
  FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
}

/// A line for the log file and the terminal, in the core's format:
/// `15:05:41 shell  message`. The file keeps every line with its epoch time.
func log(_ s: String) {
  toFile(s)
  let t = clock.string(from: Date())
  toTerminal("\(useColor ? "\u{1b}[2m\(t)\u{1b}[0m" : t) shell  \(s)")
}

/// A line only the log file gets, unless STEAMBUN_VERBOSE is set: the
/// shell's internals, which help debug it but not the app.
func debug(_ s: String) {
  if verbose { log(s) } else { toFile(s) }
}

/// A line from the core, already in its own format, so the terminal gets
/// it as it is. Bun's dev server prints "Bundled page in 2ms" on each
/// load. That is a timing, so it goes to the file only.
func coreLog(_ s: String) {
  toFile("core: \(s)")
  let plain = s.replacingOccurrences(of: "\u{1b}\\[[0-9;]*m", with: "", options: .regularExpression)
  if verbose || !plain.hasPrefix("Bundled page in ") { toTerminal(s) }
}

// MARK: - Environment

func corePath() -> String {
  if let p = ProcessInfo.processInfo.environment["STEAMBUN_CORE"] { return p }
  return Bundle.main.bundleURL
    .appendingPathComponent("Contents/Helpers/\(Config.name)-core").path
}

/// True if nothing listens on 127.0.0.1:port.
func portFree(_ port: UInt16) -> Bool {
  let fd = socket(AF_INET, SOCK_STREAM, 0)
  if fd < 0 { return false }
  defer { close(fd) }
  // Bun listens with SO_REUSEADDR, so TIME_WAIT sockets don't block it.
  var one: Int32 = 1
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
  var addr = sockaddr_in()
  addr.sin_family = sa_family_t(AF_INET)
  addr.sin_port = port.bigEndian
  addr.sin_addr.s_addr = inet_addr("127.0.0.1")
  let r = withUnsafePointer(to: &addr) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
    }
  }
  return r == 0
}

/// Ask the kernel for a free port.
func anyPort() -> UInt16 {
  let fd = socket(AF_INET, SOCK_STREAM, 0)
  defer { close(fd) }
  var addr = sockaddr_in()
  addr.sin_family = sa_family_t(AF_INET)
  addr.sin_port = 0
  addr.sin_addr.s_addr = inet_addr("127.0.0.1")
  var len = socklen_t(MemoryLayout<sockaddr_in>.size)
  _ = withUnsafeMutablePointer(to: &addr) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      bind(fd, $0, len)
      return getsockname(fd, $0, &len)
    }
  }
  return UInt16(bigEndian: addr.sin_port)
}

// MARK: - Core process

final class Core {
  let proc = Process()
  let port: UInt16
  let pidFile: String
  /// Called once, off the main thread, when the core prints STEAMBUN_READY.
  private var onReady: (() -> Void)?
  private let readyLock = NSLock()
  private var partial = ""

  /// `bun` runs the core's JS with the user's bun (`bun: "system"`);
  /// nil runs the compiled core, or STEAMBUN_CORE in dev.
  init(port: UInt16, env: [String: String], home: String, bun: String? = nil) {
    self.port = port
    pidFile = (home as NSString).appendingPathComponent("native-core.pid")
    if let bun {
      proc.executableURL = URL(fileURLWithPath: bun)
      proc.arguments = [Config.coreScript]
      proc.currentDirectoryURL = URL(fileURLWithPath: SystemBun.dir)
    } else {
      proc.executableURL = URL(fileURLWithPath: corePath())
      proc.arguments = []
    }
    var env = env
    env["STEAMBUN_PORT"] = String(port)
    proc.environment = env
    // The core's stdout and stderr go to our log.
    let out = Pipe()
    proc.standardOutput = out
    proc.standardError = out
    proc.standardInput = Pipe()
    out.fileHandleForReading.readabilityHandler = { [weak self] h in
      let d = h.availableData
      if d.isEmpty { h.readabilityHandler = nil; return }
      self?.lines(String(decoding: d, as: UTF8.self))
    }
  }

  /// A read can end mid-line: keep the rest for the next one.
  private func lines(_ s: String) {
    var parts = (partial + s).components(separatedBy: "\n")
    partial = parts.removeLast()
    for line in parts where !line.isEmpty {
      if line.hasPrefix("STEAMBUN_READY") { ready() } else { coreLog(line) }
    }
  }

  private func ready() {
    readyLock.lock()
    let f = onReady
    onReady = nil
    readyLock.unlock()
    f?()
  }

  /// A core left over from a shell killed with -9. serve() exits within a
  /// second when the shell dies, but a core without serve() does not, and
  /// a quick relaunch can come first. Either way, it holds our port.
  static func reapStale(home: String) {
    let pidFile = (home as NSString).appendingPathComponent("native-core.pid")
    guard let s = try? String(contentsOfFile: pidFile, encoding: .utf8),
      let pid = Int32(s.trimmingCharacters(in: .whitespacesAndNewlines))
    else { return }
    // Only kill it if it is still our core.
    var buf = [CChar](repeating: 0, count: Int(MAXPATHLEN))
    if proc_pidpath(pid, &buf, UInt32(buf.count)) > 0 {
      let path = String(cString: buf)
      // A system bun is anyone's bun: only ours if it runs from our folder.
      let ours = Config.systemBun && path.hasSuffix("/bun") && cwd(of: pid) == SystemBun.dir
      if ours || path.hasSuffix("\(Config.name)-core") || path.hasSuffix("/\(Config.name)") {
        kill(pid, SIGTERM)
        // Wait for it to free the port, so we keep the same origin.
        for _ in 0..<100 where kill(pid, 0) == 0 { usleep(10_000) }
        debug("reaped stale core pid \(pid)")
      }
    }
  }

  private static func cwd(of pid: Int32) -> String? {
    var info = proc_vnodepathinfo()
    let n = proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, Int32(MemoryLayout<proc_vnodepathinfo>.size))
    guard n > 0 else { return nil }
    return withUnsafePointer(to: &info.pvi_cdir.vip_path) {
      $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) { String(cString: $0) }
    }
  }

  func start() throws {
    try proc.run()
    try? String(proc.processIdentifier).write(toFile: pidFile, atomically: true, encoding: .utf8)
    debug("core started pid \(proc.processIdentifier) port \(port)")
  }

  /// serve() prints STEAMBUN_READY once it listens. A core without serve()
  /// never does, so also poll, but slowly.
  func waitReady(timeout: TimeInterval, done: @escaping (Bool) -> Void) {
    var called = false
    let once: (Bool) -> Void = { ok in
      self.readyLock.lock()
      let first = !called
      called = true
      self.onReady = nil
      self.readyLock.unlock()
      if first { done(ok) }
    }
    readyLock.lock()
    onReady = { once(true) }
    readyLock.unlock()
    let url = URL(string: "http://127.0.0.1:\(port)/api/meta")!
    let deadline = Date().addingTimeInterval(timeout)
    func poll() {
      readyLock.lock()
      let over = called
      readyLock.unlock()
      if over { return }
      var req = URLRequest(url: url)
      req.timeoutInterval = 0.5
      URLSession.shared.dataTask(with: req) { _, res, _ in
        if (res as? HTTPURLResponse)?.statusCode == 200 { return once(true) }
        if Date() > deadline || !self.proc.isRunning { return once(false) }
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.25, execute: poll)
      }.resume()
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.25, execute: poll)
  }

  func stop() {
    guard proc.isRunning else { return }
    proc.terminate()
    let deadline = Date().addingTimeInterval(2)
    while proc.isRunning && Date() < deadline { usleep(10_000) }
    if proc.isRunning { kill(proc.processIdentifier, SIGKILL) }
    try? FileManager.default.removeItem(atPath: pidFile)
    debug("core stopped")
  }
}

// MARK: - Window chrome

/// The web view swallows mouse events, so a full-size-content window can't
/// be dragged by its title bar. This strip sits over the top inset,
/// `window.dragWidth` wide.
final class DragStrip: NSView {
  override func mouseDown(with e: NSEvent) {
    if e.clickCount == 2 { (NSApp.delegate as? Shell)?.titleDoubleClick() } else { window?.performDrag(with: e) }
  }
}

let TITLEBAR: CGFloat = Config.hiddenTitlebar && !Config.menuBar ? 28 : 0

/// A web view whose right-click menu fits an app, not a browser: no Reload,
/// Back, Open in New Window, Download or (outside dev) Inspect Element.
/// The page already skips the menu where it has nothing useful to show.
final class AppWebView: WKWebView {
  static var inspect = false
  static let drop: Set<String> = [
    "WKMenuItemIdentifierReload", "WKMenuItemIdentifierGoBack", "WKMenuItemIdentifierGoForward",
    "WKMenuItemIdentifierOpenLinkInNewWindow", "WKMenuItemIdentifierDownloadLinkedFile",
    "WKMenuItemIdentifierOpenImageInNewWindow", "WKMenuItemIdentifierDownloadImage",
    "WKMenuItemIdentifierOpenMediaInNewWindow", "WKMenuItemIdentifierDownloadMedia",
    "WKMenuItemIdentifierOpenFrameInNewWindow", "WKMenuItemIdentifierCopyImage",
  ]

  static func prune(_ menu: NSMenu) {
    for it in menu.items {
      let id = it.identifier?.rawValue ?? ""
      if drop.contains(id) || (!inspect && id == "WKMenuItemIdentifierInspectElement") {
        menu.removeItem(it)
      }
    }
    // No separator at either end or twice in a row.
    var prevSep = true
    for it in menu.items {
      if it.isSeparatorItem && prevSep { menu.removeItem(it) } else { prevSep = it.isSeparatorItem }
    }
    if let last = menu.items.last, last.isSeparatorItem { menu.removeItem(last) }
  }

  override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
    AppWebView.prune(menu)
    super.willOpenMenu(menu, with: event)
  }
}

/// How long WebKit can take to save a localStorage write, with a margin.
/// Measured: a quit 300 ms after a write lost it; 600 ms never did.
let storageSaveMs: Double = 800

// Runs before the page. Generic: it knows nothing about the app.
// It marks the shell and its title bar height for CSS, lists the ops this
// shell supports, and holds events until steambun/ui/native.ts takes over.
// The page does the rest (steambun/ui/shell.ts): drag areas, first paint.
func bootJS(test: Bool) -> String {
  let ops = (try? JSONSerialization.data(withJSONObject: BRIDGE_PAGE_OPS + APP_PAGE_OPS)).map {
    String(decoding: $0, as: UTF8.self)
  } ?? "[]"
  return """
    document.documentElement.dataset.shell = "mac";\(Config.glass ? "\n    document.documentElement.dataset.glass = \"\";" : "")
    document.documentElement.style.setProperty("--shell-titlebar", "\(Int(TITLEBAR))px");
    window.__steambun = { ops: \(ops), test: \(test), q: [], emit(n, p) { this.q.push([n, p]); } };
    for (const k of ["setItem", "removeItem", "clear"]) {
      const f = Storage.prototype[k];
      Storage.prototype[k] = function (...a) { window.__steambunWroteAt = Date.now(); return f.apply(this, a); };
    }
    """
}

/// WebKit holds a page to about 60 fps on 120 Hz screens ("Prefer Page
/// Rendering Updates near 60fps", on by default, as in Safari). Turn it off,
/// so the app draws at the screen's full rate like a native view. Measured on
/// the built-in ProMotion screen: 61 fps before, 120 after.
/// Private WebKit API: if a macOS update removes the feature, this does
/// nothing and the page stays at 60.
func allowFullFrameRate(_ p: WKPreferences) {
  let list = NSSelectorFromString("_features"), set = NSSelectorFromString("_setEnabled:forFeature:")
  guard WKPreferences.responds(to: list), p.responds(to: set),
    let feats = (WKPreferences.self as AnyObject).perform(list)?.takeUnretainedValue() as? [NSObject],
    let f = feats.first(where: { ($0.value(forKey: "key") as? String) == "PreferPageRenderingUpdatesNear60FPSEnabled" })
  else { return debug("60fps preference not found; the page stays near 60 fps") }
  typealias Fn = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
  unsafeBitCast(p.method(for: set), to: Fn.self)(p, set, false, f)
}

// MARK: - Shell

final class Shell: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate,
  WKScriptMessageHandlerWithReply, BridgeHandlers, BridgeEmitter
{
  var window: NSWindow!
  var web: WKWebView!
  var lastDown: NSEvent?
  var drags = 0
  /// Menu items that run a page command, by command id.
  var commandItems: [String: NSMenuItem] = [:]
  /// Menu keys from the config, until the page sends its key map.
  var defaultKeys: [String: [String]] = [:]
  var core: Core!
  var coreEnv: [String: String] = [:]
  var home = ""
  var port: UInt16 = 0
  var quitting = false
  var restarts: [Date] = []
  var hotKey: EventHotKeyRef?
  /// A menu bar app (MenuBar.swift): its item, and the page load it holds
  /// until the panel first opens.
  var statusItem: NSStatusItem?
  var pendingLoad: (() -> Void)?
  var panelOpened = false
  var panelHidAt = Date.distantPast
  /// Watches clicks in other apps while the panel is open.
  var outsideClicks: Any?
  var toolbarDelegate: Toolbar?
  /// Real browser pages the core drives (Pages.swift). The token lets only
  /// this shell open the core's native socket.
  let nativeToken = (0..<32).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
  lazy var pages = Pages(token: nativeToken)
  let system = SystemWatch()
  var updater: Updater?
  var updateItem: NSMenuItem!
  var relaunchAfterUpdate = false
  /// Found once per launch, for `bun: "system"`.
  var systemBun: Result<String, SystemBun.Failure>?
  let env = ProcessInfo.processInfo.environment
  /// A test harness drives this run (Test.swift): links open nowhere, and
  /// the page exposes test handles.
  let testURL = opt("STEAMBUN_TEST_WS").flatMap(URL.init(string:))
  var testing: Bool { testURL != nil }
  lazy var tests = Tests(app: self)

  func applicationDidFinishLaunching(_ n: Notification) {
    debug("launched")
    appWillLaunch()
    buildMenu()
    buildWindow()
    if let u = testURL {
      debug("test harness at \(u)")
      tests.link.connect(url: u)
    }

    // The core gets our env. It asks the login shell for PATH itself, in
    // the background (steambun/core/env.ts), so launch doesn't wait on it.
    coreEnv = env
    if opt("STEAMBUN_NOPATHFIX") == "1" {
      debug("PATH fix off")
    } else {
      coreEnv["STEAMBUN_LOGIN_SHELL"] = env["SHELL"] ?? "/bin/zsh"
    }
    debug("inherited PATH: \(env["PATH"] ?? "-")")
    coreEnv["STEAMBUN_PARENT_PID"] = String(getpid())
    coreEnv["STEAMBUN_TOKEN"] = nativeToken
    home = opt("STEAMBUN_HOME") ?? (Config.home as NSString).expandingTildeInPath
    try? FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)
    coreEnv["STEAMBUN_HOME"] = home

    guard Config.hasCore else { return startPage() }
    Core.reapStale(home: home)
    // A stable port keeps a stable origin. Settings live in the core, so a
    // fallback port keeps them. Only per-origin state (localStorage) resets.
    let preferred: UInt16 = UInt16(opt("STEAMBUN_PORT") ?? "") ?? Config.port
    port = portFree(preferred) ? preferred : anyPort()
    startCore(first: true)

    registerHotKey()
    checkNotifications()
    setUpUpdates()
  }

  /// No core: load the built page from the bundle, or the dev server's
  /// URL under `steambun dev --native`.
  func startPage() {
    registerHotKey()
    checkNotifications()
    setUpUpdates()
    let url = opt("STEAMBUN_URL").flatMap(URL.init(string:)) ?? pageURL
    debug("no core; page at \(url.absoluteString)")
    load { self.web.load(URLRequest(url: url)) }
  }

  /// A URL the page owns: the core, the dev server or the bundled page.
  func isOurs(_ url: URL) -> Bool {
    url.scheme == pageScheme || url.scheme == "about" || url.host == "127.0.0.1"
  }

  // MARK: Updates

  func setUpUpdates() {
    let info = Bundle.main.infoDictionary ?? [:]
    let current = info["CFBundleShortVersionString"] as? String ?? "0"
    updater = Updater(
      feed: opt("STEAMBUN_UPDATE_URL") ?? info["SteambunUpdateURL"] as? String,
      key: info["SteambunUpdateKey"] as? String,
      app: Bundle.main.bundleURL, current: current, home: home)
    guard let updater else {
      updateItem.isHidden = true
      return debug("updates off: no feed or key in this build")
    }
    debug("updates on: \(updater.feed.absoluteString), current \(current)")
    updater.onStaged = { v in
      self.updateItem.title = "Restart to Update to \(v)"
      self.updateItem.action = #selector(self.restartToUpdate)
    }
    // Soon after launch, then once a day.
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { updater.check() }
    Timer.scheduledTimer(withTimeInterval: 24 * 3600, repeats: true) { _ in updater.check() }
  }

  @objc func checkForUpdates() {
    updater?.check { msg in
      guard self.updater?.staged == nil else { return }
      let a = NSAlert()
      a.messageText = msg.hasPrefix("up to date") ? "\(Config.name) is up to date." : "Update check failed."
      a.informativeText = msg
      a.runModal()
    }
  }

  @objc func restartToUpdate() {
    relaunchAfterUpdate = true
    NSApp.terminate(nil)
  }

  /// Start the core. If it exits while we're not quitting, start it again
  /// (at most 3 times a minute) and reload the page in place.
  func startCore(first: Bool) {
    // The user's bun, unless dev points STEAMBUN_CORE at the source.
    var bun: String?
    if Config.systemBun && opt("STEAMBUN_CORE") == nil {
      if systemBun == nil { systemBun = SystemBun.find() }
      switch systemBun! {
      case .success(let p): bun = p
      case .failure(let f):
        load { self.web.loadHTMLString(SystemBun.page(f), baseURL: nil) }
        return
      }
    }
    core = Core(port: port, env: coreEnv, home: home, bun: bun)
    core.proc.terminationHandler = { p in
      DispatchQueue.main.async {
        guard !self.quitting else { return }
        log("core exited unexpectedly (status \(p.terminationStatus))")
        let now = Date()
        self.restarts = self.restarts.filter { now.timeIntervalSince($0) < 60 } + [now]
        guard self.restarts.count <= 3 else {
          return self.fail("The \(Config.name) core keeps stopping. See the log for details.")
        }
        self.startCore(first: false)
      }
    }
    do { try core.start() } catch {
      log("core failed to start: \(error)")
      return fail("Could not start the \(Config.name) core: \(error.localizedDescription)")
    }
    core.waitReady(timeout: 15) { ok in
      DispatchQueue.main.async {
        guard ok else { return self.fail("The \(Config.name) core did not answer.") }
        if first { debug("core ready") } else { log("core restarted") }
        let link = self.pages.link
        link.onOpen = { [weak self] in if let self { link.send(self.system.event) } }
        self.system.onChange = { [weak self] _ in if let self { link.send(self.system.event) } }
        link.connect(port: self.port)
        if first || self.web.url?.host != "127.0.0.1" {
          self.load { self.web.load(URLRequest(url: URL(string: "http://127.0.0.1:\(self.port)/")!)) }
        } else {
          self.web.reload()
        }
      }
    }
  }

  /// WebKit's storage process saves localStorage on a timer, about 0.5 s
  /// after a write. A quit inside that window (⌘Q right after an edit, or
  /// SIGTERM) loses the write. The page notes when it last wrote (bootJS),
  /// so a quit waits out the rest of the window, and only after a write.
  func applicationShouldTerminate(_ s: NSApplication) -> NSApplication.TerminateReply {
    guard let web, web.url != nil else { return .terminateNow }
    var replied = false
    let reply = {
      guard !replied else { return }
      replied = true
      NSApp.reply(toApplicationShouldTerminate: true)
    }
    // Run-loop timers, not asyncAfter: SIGTERM quits from a main-queue
    // block, and GCD runs no other main-queue block until it returns.
    let after = { (sec: Double) in
      RunLoop.main.add(Timer(timeInterval: sec, repeats: false) { _ in reply() }, forMode: .common)
    }
    web.evaluateJavaScript("Date.now() - (window.__steambunWroteAt ?? 0)") { r, _ in
      let since = (r as? NSNumber)?.doubleValue ?? .infinity
      after(max(0, storageSaveMs - since) / 1000)
    }
    // A page that doesn't answer can't hold up the quit.
    after(storageSaveMs / 1000 + 0.2)
    return .terminateLater
  }

  func applicationWillTerminate(_ n: Notification) {
    quitting = true
    pages.link.stop()
    core?.stop()
    // A staged update goes in on any quit, not only "Restart to Update".
    updater?.install(relaunch: relaunchAfterUpdate)
  }
  var screenHz: Int { (window?.screen ?? NSScreen.main)?.maximumFramesPerSecond ?? 60 }
  /// Tell the page the refresh rate of the screen the window is on. The dev
  /// meter uses it instead of guessing from frame times.
  @objc func sendRefreshRate() { emitScreenHz(ScreenHz(hz: screenHz)) }

  /// A menu bar app lives on with its panel closed.
  func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { !Config.menuBar }

  func fail(_ msg: String) {
    load {
      self.web.loadHTMLString(
        "<body style='font:13px -apple-system;padding:40px;color:#666'>\(msg)</body>", baseURL: nil)
    }
  }

  func buildWindow() {
    let cfg = WKWebViewConfiguration()
    // localStorage and caches survive relaunch (webStore).
    cfg.websiteDataStore = webStore
    let ucc = WKUserContentController()
    ucc.addUserScript(WKUserScript(source: bootJS(test: testing), injectionTime: .atDocumentStart, forMainFrameOnly: true))
    ucc.addScriptMessageHandler(self, contentWorld: .page, name: "steambun")
    cfg.userContentController = ucc
    if !Config.hasCore {
      let root = Bundle.main.resourceURL!.appendingPathComponent("page")
      cfg.setURLSchemeHandler(PageScheme(root: root), forURLScheme: pageScheme)
    }
    cfg.setURLSchemeHandler(SymbolScheme(), forURLScheme: symbolScheme)
    allowFullFrameRate(cfg.preferences)
    if opt("STEAMBUN_INSPECT") == "1" { cfg.preferences.setValue(true, forKey: "developerExtrasEnabled") }

    AppWebView.inspect = opt("STEAMBUN_INSPECT") == "1"
    web = AppWebView(frame: .zero, configuration: cfg)
    // The page asks to drag after it sees the press; keep the press to hand over.
    NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] e in
      self?.lastDown = e
      return e
    }
    web.navigationDelegate = self
    web.uiDelegate = self
    web.isInspectable = true
    // Avoid a white flash before the first paint in dark mode.
    web.underPageBackgroundColor = .windowBackgroundColor
    web.setValue(false, forKey: "drawsBackground")

    window = Config.menuBar ? makePanel() : NSWindow(
      contentRect: NSRect(origin: .zero, size: Config.size),
      styleMask: Config.hiddenTitlebar
        ? [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
        : [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    if !Config.menuBar {
      window.titlebarAppearsTransparent = Config.hiddenTitlebar
      window.titleVisibility = Config.hiddenTitlebar ? .hidden : .visible
      window.title = Config.name
      window.backgroundColor = .windowBackgroundColor
      window.contentMinSize = Config.minSize
      buildToolbar()
    }
    // Moving to another screen, or a screen's mode changing, can change the rate.
    for n in [NSWindow.didChangeScreenNotification, NSApplication.didChangeScreenParametersNotification] {
      NotificationCenter.default.addObserver(self, selector: #selector(sendRefreshRate), name: n, object: nil)
    }
    let root = NSView()
    if Config.glass {
      // The page draws no background, so the glass shows through it.
      window.isOpaque = false
      window.backgroundColor = .clear
      web.underPageBackgroundColor = .clear
      window.contentView = glassBehind(root)
    } else {
      window.contentView = root
    }
    web.translatesAutoresizingMaskIntoConstraints = false
    root.addSubview(web)
    let strip = DragStrip()
    strip.translatesAutoresizingMaskIntoConstraints = false
    root.addSubview(strip)
    pages.main = web
    pages.layer.frame = root.bounds
    root.addSubview(pages.layer, positioned: .below, relativeTo: strip)
    NSLayoutConstraint.activate([
      web.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      web.trailingAnchor.constraint(equalTo: root.trailingAnchor),
      web.topAnchor.constraint(equalTo: root.topAnchor),
      web.bottomAnchor.constraint(equalTo: root.bottomAnchor),
      strip.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      strip.widthAnchor.constraint(equalToConstant: TITLEBAR > 0 ? Config.dragWidth : 0),
      strip.topAnchor.constraint(equalTo: root.topAnchor),
      strip.heightAnchor.constraint(equalToConstant: TITLEBAR),
    ])
    if quietTest {
      window.alphaValue = 0
      window.ignoresMouseEvents = true
    }
    // A menu bar app shows nothing until its item is clicked.
    if Config.menuBar { return buildStatusItem() }
    // Size and position survive relaunch. Test runs move the window
    // between screens, so they don't save it.
    if !testing { window.setFrameAutosaveName("main") }
    if !window.setFrameUsingName("main") { window.center() }
    // A frame saved before the minimum existed may be smaller.
    var f = window.frame
    let minFrame = window.frameRect(forContentRect: NSRect(origin: .zero, size: Config.minSize)).size
    if f.width < minFrame.width || f.height < minFrame.height {
      f.size = NSSize(width: max(f.width, minFrame.width), height: max(f.height, minFrame.height))
      window.setFrame(f, display: false)
    }
    if quietTest { return window.orderFrontRegardless() }
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  /// Wrap the window's content in real glass (`glass` in the config):
  /// Liquid Glass on macOS 26 and later, the older behind-window blur before.
  func glassBehind(_ content: NSView) -> NSView {
    // NSGlassEffectView is in the macOS 26 SDK. FoundationModels came in
    // the same SDK, so it marks one. An older SDK builds the blur only.
    #if canImport(FoundationModels)
    if #available(macOS 26, *) {
      let g = NSGlassEffectView()
      g.contentView = content
      return g
    }
    #endif
    let v = NSVisualEffectView()
    v.material = Config.menuBar ? .popover : .underWindowBackground
    v.blendingMode = .behindWindow
    v.state = .active
    content.frame = v.bounds
    content.autoresizingMask = [.width, .height]
    v.addSubview(content)
    return v
  }

  /// Double-click on a title area does what System Settings says.
  func titleDoubleClick() {
    switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
    case "Minimize": window.performMiniaturize(nil)
    case "None": break
    default: window.performZoom(nil)
    }
  }

  // The global hotkey from the config: show or hide the app from anywhere.
  // Carbon hot keys need no Accessibility permission.
  func registerHotKey() {
    guard let (code, mods) = Config.hotkey else { return }
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(
      GetApplicationEventTarget(),
      { _, _, _ in
        DispatchQueue.main.async {
          if Config.menuBar {
            (NSApp.delegate as? Shell)?.togglePanel()
          } else if NSApp.isActive { NSApp.hide(nil) } else { NSApp.activate(ignoringOtherApps: true) }
        }
        return noErr
      }, 1, &spec, nil, nil)
    let id = EventHotKeyID(signature: OSType(0x7374_6221), id: 1)
    let st = RegisterEventHotKey(code, mods, id, GetApplicationEventTarget(), 0, &hotKey)
    if st == noErr { debug("global hotkey registered") } else { log("global hotkey failed: \(st)") }
  }

  func checkNotifications() {
    // Only read the status. Asking would show a prompt; do that on first use.
    UNUserNotificationCenter.current().getNotificationSettings { s in
      debug("notifications: authorizationStatus=\(s.authorizationStatus.rawValue)")
    }
  }

  // MARK: Navigation

  func webView(
    _ w: WKWebView, decidePolicyFor a: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    if let url = a.request.url, !isOurs(url) {
      if !testing { NSWorkspace.shared.open(url) }
      debug("external link → default browser: \(url.absoluteString)")
      return decisionHandler(.cancel)
    }
    decisionHandler(.allow)
  }

  /// `<input type="file">`: WKWebView shows nothing unless we open the panel.
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

  // target=_blank and window.open land here.
  func webView(
    _ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction,
    windowFeatures f: WKWindowFeatures
  ) -> WKWebView? {
    if let url = a.request.url {
      if !testing { NSWorkspace.shared.open(url) }
      debug("new-window link → default browser: \(url.absoluteString)")
    }
    return nil
  }

  // A new main page places its panes again when it shows them.
  func webView(_ w: WKWebView, didCommit n: WKNavigation!) { pages.hideAll() }

  func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
    debug("didFinish \(w.url?.path ?? "")")
    sendRefreshRate()
  }

  func webViewWebContentProcessDidTerminate(_ w: WKWebView) {
    log("web content process died; reloading")
    w.reload()
  }

  // MARK: Bridge (steambun/bridge.ts)

  func userContentController(
    _ u: WKUserContentController, didReceive m: WKScriptMessage,
    replyHandler: @escaping (Any?, String?) -> Void
  ) {
    guard let b = m.body as? [String: Any], let op = b["op"] as? String else {
      return replyHandler(nil, "bad message")
    }
    do {
      let r = try bridgeDispatch(op, b["args"])
      guard let job = r as? BridgeAsync else { return replyHandler(r, nil) }
      Task { @MainActor in
        do { replyHandler(try await job.run(), nil) } catch {
          log("bridge \(op): \(error.localizedDescription)")
          replyHandler(nil, error.localizedDescription)
        }
      }
    } catch {
      log("bridge \(op): \(error.localizedDescription)")
      replyHandler(nil, error.localizedDescription)
    }
  }

  /// Events go to steambun/ui/native.ts, or wait in its queue until it loads.
  func emit(_ name: String, _ json: String) {
    // No page yet, so no one listens. Running JS would start a web
    // content process for nothing, which a menu bar app holds off on.
    guard let web, web.url != nil else { return }
    web.evaluateJavaScript("window.__steambun?.emit(\(String(reflecting: name)), \(json))")
  }

  func appInfo() -> AppInfo {
    let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    return AppInfo(version: v ?? "dev", hz: screenHz, test: testing)
  }

  func appPaint(_ a: AppPaintArgs) {
    let webkit = a.fcp.map { String(format: " (WebKit's first paint %.0f ms)", $0) } ?? ""
    debug(String(format: "first paint %.0f ms after navigation start", a.ms) + webkit)
  }

  func windowDrag() -> Bool {
    drags += 1
    // Only while the button is still down: a late message must not
    // start a drag that follows the pointer with no button held.
    guard let e = lastDown, NSEvent.pressedMouseButtons & 1 == 1 else { return false }
    window.performDrag(with: e)
    return true
  }

  func windowZoom() { titleDoubleClick() }

  func menuSetKeys(_ a: MenuSetKeysArgs) { applyKeys(a.map) }

  func panePlace(_ a: PanePlaceArgs) { pages.place(a.id, a.rect) }
}

let app = NSApplication.shared
// SIGTERM (`kill`, a test harness, logout) quits like ⌘Q: the page's
// storage is saved and the core stops. The default would drop both.
signal(SIGTERM, SIG_IGN)
let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigterm.setEventHandler { NSApp.terminate(nil) }
sigterm.resume()
let delegate = Shell()
app.delegate = delegate
// A menu bar app has no Dock icon (LSUIElement says so too, but not in dev).
// A quiet test run has none either, and takes no focus (Test.swift).
app.setActivationPolicy(Config.menuBar || quietTest ? .accessory : .regular)
app.run()
