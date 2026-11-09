// Over-the-air updates. See docs/design.md → "Own notarization and updates".
//
// The feed is a folder on any static host:
//   latest.json       the manifest: version and one entry per file in the .app
//   latest.json.sig   base64 ed25519 signature over latest.json's bytes
//   blobs/<sha>.zst   each file, zstd
//   patches/<from>-<to>.zst   zstd --patch-from the old file's bytes
//
// We stage a patched copy of the .app, check every file's hash and the code
// signature, then swap it in on quit. Nothing is re-signed here: the staged
// app is the release, byte for byte.
import CryptoKit
import Foundation
import Security

struct Manifest: Decodable {
  struct File: Decodable {
    let path: String
    let sha256: String
    let size: Int
    let mode: Int
    let blob: String
    let patches: [String: String]?
  }
  let version: String
  let files: [File]
}

enum UpdateError: Error, CustomStringConvertible {
  case http(String, Int)
  case badSignature
  case badHash(String)
  case zstd(String)
  case codesign(OSStatus)
  case swap(Int32)
  var description: String {
    switch self {
    case .http(let u, let s): "GET \(u) → \(s)"
    case .badSignature: "manifest signature is not valid"
    case .badHash(let p): "hash mismatch for \(p)"
    case .zstd(let e): "zstd: \(e)"
    case .codesign(let s): "code signature check failed (\(s))"
    case .swap(let e): "swap failed: \(String(cString: strerror(e)))"
    }
  }
}

func sha256(_ d: Data) -> String {
  SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined()
}

/// Dotted versions compared as numbers: 0.10.0 > 0.9.9.
func newer(_ a: String, than b: String) -> Bool {
  let x = a.split(separator: ".").map { Int($0) ?? 0 }
  let y = b.split(separator: ".").map { Int($0) ?? 0 }
  for i in 0..<max(x.count, y.count) {
    let l = i < x.count ? x[i] : 0, r = i < y.count ? y[i] : 0
    if l != r { return l > r }
  }
  return false
}

/// Decompress a zstd frame. With `ref`, the frame is a patch made with
/// `zstd --patch-from=ref`.
func unzstd(_ src: Data, ref: Data?, size: Int) throws -> Data {
  guard let dctx = ZSTD_createDCtx() else { throw UpdateError.zstd("no context") }
  defer { ZSTD_freeDCtx(dctx) }
  // Patches against a large file use a window as large as that file.
  ZSTD_DCtx_setParameter(dctx, ZSTD_d_windowLogMax, 31)
  var out = Data(count: size)
  let n: Int = try out.withUnsafeMutableBytes { o in
    try src.withUnsafeBytes { s in
      func run() -> Int {
        ZSTD_decompressDCtx(dctx, o.baseAddress, size, s.baseAddress, src.count)
      }
      guard let ref else { return run() }
      return try ref.withUnsafeBytes { r in
        let e = ZSTD_DCtx_refPrefix(dctx, r.baseAddress, ref.count)
        if ZSTD_isError(e) != 0 { throw UpdateError.zstd(String(cString: ZSTD_getErrorName(e))) }
        return run()
      }
    }
  }
  if ZSTD_isError(n) != 0 { throw UpdateError.zstd(String(cString: ZSTD_getErrorName(n))) }
  guard n == size else { throw UpdateError.zstd("size \(n), want \(size)") }
  return out
}

final class Updater {
  let feed: URL
  let key: Curve25519.Signing.PublicKey
  let app: URL
  let current: String
  let home: URL
  private(set) var staged: (version: String, url: URL)?
  private var busy = false
  /// Called on the main queue after an update is staged.
  var onStaged: ((String) -> Void)?

  /// Nil when the build has no feed or no key: updates are off.
  init?(feed: String?, key: String?, app: URL, current: String, home: String) {
    guard let feed, !feed.isEmpty, let f = URL(string: feed.hasSuffix("/") ? feed : feed + "/"),
      let key, let raw = Data(base64Encoded: key),
      let k = try? Curve25519.Signing.PublicKey(rawRepresentation: raw)
    else { return nil }
    self.feed = f
    self.key = k
    self.app = app
    self.current = current
    self.home = URL(fileURLWithPath: home).appendingPathComponent("updates")
  }

  private func get(_ path: String) throws -> Data {
    let url = URL(string: path, relativeTo: feed)!
    var req = URLRequest(url: url)
    req.cachePolicy = .reloadIgnoringLocalCacheData
    req.timeoutInterval = 30
    let sem = DispatchSemaphore(value: 0)
    var out: Result<Data, Error> = .failure(UpdateError.http(url.absoluteString, -1))
    URLSession.shared.dataTask(with: req) { d, r, e in
      let s = (r as? HTTPURLResponse)?.statusCode ?? -1
      if let d, s == 200 { out = .success(d) } else { out = .failure(e ?? UpdateError.http(url.absoluteString, s)) }
      sem.signal()
    }.resume()
    sem.wait()
    return try out.get()
  }

  /// Check the feed and stage an update if there is a newer one.
  /// Runs off the main thread.
  func check(manual: Bool = false, done: ((String) -> Void)? = nil) {
    guard !busy else { return }
    busy = true
    DispatchQueue.global(qos: .utility).async {
      let msg: String
      do { msg = try self.run() } catch {
        msg = "update failed: \(error)"
      }
      log(msg)
      DispatchQueue.main.async {
        self.busy = false
        done?(msg)
      }
    }
  }

  private func run() throws -> String {
    let t0 = Date()
    let body = try get("latest.json")
    let sigText = String(decoding: try get("latest.json.sig"), as: UTF8.self)
    guard let sig = Data(base64Encoded: sigText.trimmingCharacters(in: .whitespacesAndNewlines)),
      key.isValidSignature(sig, for: body)
    else { throw UpdateError.badSignature }
    let m = try JSONDecoder().decode(Manifest.self, from: body)
    guard newer(m.version, than: current) else { return "up to date (\(current))" }
    if staged?.version == m.version { return "\(m.version) already staged" }

    // Stage on the same volume as the app, so the swap is one rename.
    let dir = try FileManager.default.url(
      for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: app, create: true)
    let dst = dir.appendingPathComponent(app.lastPathComponent)
    // Leave nothing behind if any step fails.
    var ok = false
    defer { if !ok { try? FileManager.default.removeItem(at: dir) } }
    // APFS clones the copy, so this is fast and takes no space.
    try FileManager.default.copyItem(at: app, to: dst)

    var bytes = 0, patched = 0, full = 0
    for f in m.files {
      let local = app.appendingPathComponent(f.path)
      let old = try? Data(contentsOf: local)
      let oldSha = old.map(sha256)
      if oldSha == f.sha256 { continue }
      var data: Data?
      // Prefer a patch from the bytes we have; fall back to the whole file.
      if let old, let oldSha, let p = f.patches?[oldSha] {
        if let z = try? get(p), let d = try? unzstd(z, ref: old, size: f.size), sha256(d) == f.sha256 {
          data = d
          bytes += z.count
          patched += 1
        }
      }
      if data == nil {
        let z = try get(f.blob)
        let d = try unzstd(z, ref: nil, size: f.size)
        guard sha256(d) == f.sha256 else { throw UpdateError.badHash(f.path) }
        data = d
        bytes += z.count
        full += 1
      }
      let out = dst.appendingPathComponent(f.path)
      try FileManager.default.createDirectory(
        at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
      // Write a new inode: the clone shares blocks with the running app.
      try? FileManager.default.removeItem(at: out)
      try data!.write(to: out)
      try FileManager.default.setAttributes([.posixPermissions: f.mode], ofItemAtPath: out.path)
    }

    // Drop files the new version no longer has.
    // Relative paths: /var and /private/var name the same folder.
    let keep = Set(m.files.map(\.path))
    let fm = FileManager.default
    for case let rel as String in fm.enumerator(atPath: dst.path)! {
      var isDir: ObjCBool = false
      let full = dst.appendingPathComponent(rel).path
      if fm.fileExists(atPath: full, isDirectory: &isDir), !isDir.boolValue, !keep.contains(rel) {
        try fm.removeItem(atPath: full)
      }
    }

    // Every file must match the signed manifest...
    for f in m.files {
      let d = try Data(contentsOf: dst.appendingPathComponent(f.path))
      guard sha256(d) == f.sha256 else { throw UpdateError.badHash(f.path) }
    }
    // ...and the app must pass macOS's own signature check, by the same signer.
    try verifySignature(dst)

    ok = true
    staged = (m.version, dst)
    DispatchQueue.main.async { self.onStaged?(m.version) }
    return String(
      format: "staged %@: %d patched, %d full, %.0f KB in %.1f s",
      m.version, patched, full, Double(bytes) / 1024, Date().timeIntervalSince(t0))
  }

  /// The staged app must be validly signed, with our identifier, and by our
  /// team when we have one (ad hoc builds have none).
  private func verifySignature(_ url: URL) throws {
    var code: SecStaticCode?
    var s = SecStaticCodeCreateWithPath(url as CFURL, [], &code)
    guard s == errSecSuccess, let code else { throw UpdateError.codesign(s) }
    var req = "identifier \"\(Bundle.main.bundleIdentifier ?? Config.id)\""
    if let team = teamID() {
      req += " and anchor apple generic and certificate leaf[subject.OU] = \"\(team)\""
    }
    var r: SecRequirement?
    s = SecRequirementCreateWithString(req as CFString, [], &r)
    guard s == errSecSuccess else { throw UpdateError.codesign(s) }
    let flags = SecCSFlags(
      rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate | kSecCSCheckNestedCode)
    s = SecStaticCodeCheckValidity(code, flags, r)
    guard s == errSecSuccess else { throw UpdateError.codesign(s) }
  }

  private func teamID() -> String? {
    var code: SecStaticCode?
    guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code else {
      return nil
    }
    var info: CFDictionary?
    SecCodeCopySigningInformation(
      code, SecCSFlags(rawValue: kSecCSSigningInformation), &info)
    return (info as? [String: Any])?[kSecCodeInfoTeamIdentifier as String] as? String
  }

  /// Swap the staged app into place. Call after the core has stopped.
  /// The old app is kept as updates/previous.app for rollback.
  @discardableResult
  func install(relaunch: Bool) -> Bool {
    guard let (version, dst) = staged else { return false }
    if renamex_np(dst.path, app.path, UInt32(RENAME_SWAP)) != 0 {
      log("update: \(UpdateError.swap(errno))")
      return false
    }
    staged = nil
    // dst now holds the old app.
    let prev = home.appendingPathComponent("previous.app")
    try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    try? FileManager.default.removeItem(at: prev)
    do { try FileManager.default.moveItem(at: dst, to: prev) } catch {
      try? FileManager.default.removeItem(at: dst)
    }
    log("installed \(version); previous app at \(prev.path)")
    if relaunch {
      // Open the new app once this process has exited.
      let p = Process()
      p.executableURL = URL(fileURLWithPath: "/bin/sh")
      // Pass our launch arguments on (for example -STEAMBUN_HOME).
      let args = CommandLine.arguments.dropFirst()
      p.arguments = [
        "-c",
        "pid=$1; shift; while kill -0 $pid 2>/dev/null; do sleep 0.1; done; "
          + "if [ $# -gt 0 ]; then open \"$0\" --args \"$@\"; else open \"$0\"; fi",
        app.path, String(getpid()),
      ] + args
      try? p.run()
    }
    return true
  }
}
