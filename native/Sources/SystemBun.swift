// `bun: "system"`: the core is plain JS in Resources/core, and the user's
// own bun runs it. This file finds that bun and checks its version.

import Foundation

enum SystemBun {
  /// Where the core's JS lives. Bun finds the page's files from the
  /// working folder, so the core runs from here.
  static var dir: String {
    Bundle.main.resourceURL!.appendingPathComponent("core").path
  }

  /// The bun to run, or why there is none, as a message for the window.
  static func find() -> Result<String, Failure> {
    var seen: [String] = []
    var old: String?
    // The login shell is slow, so ask it only if no usual install works.
    for p in candidates() + [{ loginShellBun() }] {
      guard let p = p(), !seen.contains(p) else { continue }
      seen.append(p)
      guard FileManager.default.isExecutableFile(atPath: p) else { continue }
      guard let v = version(p) else { continue }
      if isAtLeast(v, Config.minBun) {
        log("system bun \(v) at \(p)")
        return .success(p)
      }
      // Keep looking: another install may be new enough.
      log("system bun \(v) at \(p) is older than \(Config.minBun)")
      old = old ?? v
    }
    return .failure(old.map { .old(found: $0) } ?? .missing)
  }

  enum Failure: Error {
    case missing
    case old(found: String)
  }

  /// STEAMBUN_BUN alone if set; else the usual installs. Apps opened
  /// from Finder don't get the shell's PATH, so the login shell's
  /// `command -v bun` comes last, from find().
  private static func candidates() -> [() -> String?] {
    if let p = ProcessInfo.processInfo.environment["STEAMBUN_BUN"], !p.isEmpty { return [{ p }] }
    let home = NSHomeDirectory()
    return ["\(home)/.bun/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun"].map { p in { p } }
  }

  private static func loginShellBun() -> String? {
    if let p = ProcessInfo.processInfo.environment["STEAMBUN_BUN"], !p.isEmpty { return nil }
    let r = run(ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh", ["-l", "-c", "command -v bun"])
    return r?.hasPrefix("/") == true ? r : nil
  }

  /// `bun --version` costs ~10 ms at launch, so remember it until the
  /// binary changes (an upgrade replaces it).
  private static func version(_ bun: String) -> String? {
    let real = (bun as NSString).resolvingSymlinksInPath
    let a = try? FileManager.default.attributesOfItem(atPath: real)
    let stamp = "\((a?[.size] as? Int) ?? 0)|\((a?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0)"
    let key = "steambun.bun:\(real)"
    let d = UserDefaults.standard
    if let c = d.stringArray(forKey: key), c.count == 2, c[0] == stamp { return c[1] }
    guard let v = run(bun, ["--version"]) else { return nil }
    d.set([stamp, v], forKey: key)
    return v
  }

  /// Run a command; its stdout, trimmed, if it exited 0.
  private static func run(_ exe: String, _ args: [String]) -> String? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    p.standardInput = FileHandle.nullDevice
    guard (try? p.run()) != nil else { return nil }
    let d = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    guard p.terminationStatus == 0 else { return nil }
    return String(decoding: d, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// "1.4.4" ≥ "1.4.4"; "1.5.0-canary.2" counts as 1.5.0.
  static func isAtLeast(_ v: String, _ min: String) -> Bool {
    let n = { (s: String) in
      s.split(separator: "-")[0].split(separator: ".").map { Int($0) ?? 0 }
    }
    let (a, b) = (n(v), n(min))
    for i in 0..<max(a.count, b.count) {
      let (x, y) = (i < a.count ? a[i] : 0, i < b.count ? b[i] : 0)
      if x != y { return x > y }
    }
    return true
  }

  /// The page the window shows when there's no bun to run the core.
  static func page(_ f: Failure) -> String {
    let what: String
    switch f {
    case .missing:
      what = "\(Config.name) runs on Bun, and Bun isn't installed."
    case .old(let v):
      what = "\(Config.name) needs Bun \(Config.minBun) or later. You have Bun \(v)."
    }
    let cmd = {
      if case .old = f { return "bun upgrade" }
      return "curl -fsSL https://bun.sh/install | bash"
    }()
    return """
      <body style="font:13px -apple-system;padding:40px;color:#444;max-width:460px">
      <p style="font-size:15px;color:#111">\(what)</p>
      <p>Run this in Terminal, then open \(Config.name) again:</p>
      <pre style="background:#f2f2f2;padding:10px 12px;border-radius:6px;user-select:all">\(cmd)</pre>
      <p>Or see <a href="https://bun.sh">bun.sh</a>.</p>
      </body>
      """
  }
}
