import AppKit

// The Swift side of native/bridge.ts. AI.swift, Remind.swift and
// Settings.swift hold the rest.
extension Shell {
  func appWillLaunch() {
    Reminders.shared.start(self)
  }

  func hapticTap() {
    NSHapticFeedbackManager.defaultPerformer.perform(.levelChange, performanceTime: .now)
  }

  func shareText(_ a: ShareTextArgs) {
    // The page's rect is in CSS pixels from the top left, as is WKWebView.
    let r = NSRect(x: a.x, y: a.y, width: a.width, height: a.height)
    NSSharingServicePicker(items: [a.text]).show(relativeTo: r, of: web, preferredEdge: .minY)
  }
}
