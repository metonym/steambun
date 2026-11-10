// SF Symbols for the page: sf-symbol:checklist?weight=semibold&size=17
// answers a PNG of the symbol, drawn black on clear at 2x. The page uses
// it as a CSS mask, so it takes any color: `background: currentColor`.
// steambun/ui's `symbol()` builds the URL, and gives null in a tab.
//
// Apple's license allows SF Symbols only on Apple platforms, so a tab
// needs its own icons.

import AppKit
import WebKit

let symbolScheme = "sf-symbol"

final class SymbolScheme: NSObject, WKURLSchemeHandler {
  private var cache: [String: Data] = [:]

  static let weights: [String: NSFont.Weight] = [
    "ultralight": .ultraLight, "thin": .thin, "light": .light, "regular": .regular,
    "medium": .medium, "semibold": .semibold, "bold": .bold, "heavy": .heavy, "black": .black,
  ]

  func webView(_ w: WKWebView, start task: WKURLSchemeTask) {
    guard let url = task.request.url else { return }
    let key = url.absoluteString
    if let d = cache[key] { return reply(task, url, 200, d) }
    // "sf-symbol:name?…": the URL is opaque, so take the name by hand.
    let rest = key.dropFirst(symbolScheme.count + 1).drop(while: { $0 == "/" })
    let name = String(rest.prefix(while: { $0 != "?" })).removingPercentEncoding ?? ""
    let q = URLComponents(string: key)?.queryItems ?? []
    func param(_ k: String) -> String? { q.first(where: { $0.name == k })?.value }
    let size = CGFloat(Double(param("size") ?? "") ?? 16)
    let weight = Self.weights[param("weight") ?? ""] ?? .regular
    guard let d = Self.png(name, size: size, weight: weight) else {
      log("sf-symbol: no symbol \(name)")
      return reply(task, url, 404, Data())
    }
    cache[key] = d
    reply(task, url, 200, d)
  }

  func webView(_ w: WKWebView, stop task: WKURLSchemeTask) {}

  /// The symbol at `size` pt, 2x, black on clear, padded to its own box.
  static func png(_ name: String, size: CGFloat, weight: NSFont.Weight) -> Data? {
    let cfg = NSImage.SymbolConfiguration(pointSize: size, weight: weight)
    guard let img = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
      .withSymbolConfiguration(cfg)
    else { return nil }
    let s = img.size
    guard let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: Int(ceil(s.width * 2)), pixelsHigh: Int(ceil(s.height * 2)),
      bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
      colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
    else { return nil }
    rep.size = s
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    img.draw(in: NSRect(origin: .zero, size: s))
    // Template symbols draw black; make sure, whatever the appearance.
    NSColor.black.set()
    NSRect(origin: .zero, size: s).fill(using: .sourceAtop)
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])
  }

  private func reply(_ task: WKURLSchemeTask, _ url: URL, _ status: Int, _ data: Data) {
    let r = HTTPURLResponse(
      url: url, statusCode: status, httpVersion: "HTTP/1.1",
      headerFields: [
        "Content-Type": "image/png", "Content-Length": String(data.count),
        // A page from the core is another origin; masks need CORS.
        "Access-Control-Allow-Origin": "*", "Cache-Control": "max-age=31536000",
      ])!
    task.didReceive(r)
    task.didReceive(data)
    task.didFinish()
  }
}
