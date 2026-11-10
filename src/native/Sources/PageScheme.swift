// An app with no core: the shell serves the built page (Resources/page)
// at steambun://app/. No server, no port, no Bun process.
//
// A path with no file extension gets index.html, so a client-side router
// can use real paths. /_steambun/* answers 404, so steambun/ui keeps
// settings in localStorage, which WebKit keeps per origin across launches.

import UniformTypeIdentifiers
import WebKit

let pageScheme = "steambun"
let pageURL = URL(string: "\(pageScheme)://app/")!

final class PageScheme: NSObject, WKURLSchemeHandler {
  let root: URL

  init(root: URL) { self.root = root.standardizedFileURL }

  func webView(_ w: WKWebView, start task: WKURLSchemeTask) {
    guard let url = task.request.url else { return }
    var path = url.path
    if path.isEmpty || path.hasSuffix("/") { path += "index.html" }
    if !path.hasPrefix("/_steambun/") && (path as NSString).pathExtension.isEmpty {
      path = "/index.html"
    }
    let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
    // Stay inside the page folder: no ../ out of it.
    guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
      return reply(task, url, 404, "text/plain", Data("not found".utf8))
    }
    let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType
    reply(task, url, 200, mime ?? "application/octet-stream", data)
  }

  func webView(_ w: WKWebView, stop task: WKURLSchemeTask) {}

  private func reply(_ task: WKURLSchemeTask, _ url: URL, _ status: Int, _ mime: String, _ data: Data) {
    let r = HTTPURLResponse(
      url: url, statusCode: status, httpVersion: "HTTP/1.1",
      headerFields: ["Content-Type": mime, "Content-Length": String(data.count), "Cache-Control": "no-cache"])!
    task.didReceive(r)
    task.didReceive(data)
    task.didFinish()
  }
}
