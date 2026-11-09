// A menu bar app (`menuBar` in steambun.config.ts): a status item in the
// menu bar, no Dock icon, and the page in a panel under the item.
//
// The panel is a real NSWindow, so everything that works in a window
// (keys, panes, tests) works here too. It hides when the app loses focus,
// like a menu. With a core, the page loads on the first open: until then
// the app runs no web content process at all.

import AppKit

/// A titled panel with no title bar, so it gets the system's rounded
/// corners and shadow. Titled panels can become key, so text fields work.
final class MenuPanel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }
}

extension Shell {
  /// Load the page now, or on the first open if this is a menu bar app
  /// with a core.
  func load(_ f: @escaping () -> Void) {
    if Config.menuBar && Config.hasCore && !panelOpened {
      pendingLoad = f
    } else {
      f()
    }
  }

  func makePanel() -> NSWindow {
    let p = MenuPanel(
      contentRect: NSRect(origin: .zero, size: Config.menuBarSize),
      styleMask: [.titled, .fullSizeContentView],
      backing: .buffered, defer: false)
    p.titlebarAppearsTransparent = true
    p.titleVisibility = .hidden
    for b in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
      p.standardWindowButton(b)?.isHidden = true
    }
    p.isMovable = false
    p.level = .statusBar
    p.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
    p.isReleasedWhenClosed = false
    p.title = Config.name
    p.backgroundColor = .windowBackgroundColor
    // Like a menu: a click elsewhere closes it. A test run keeps it open,
    // since the test app runs behind the terminal.
    if !testing {
      NotificationCenter.default.addObserver(
        self, selector: #selector(panelResigned), name: NSWindow.didResignKeyNotification, object: p)
    }
    return p
  }

  func buildStatusItem() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    statusItem = item
    pages.onMenuBar = { [weak self] a in self?.setStatus(icon: a.icon, title: a.title) }
    guard let b = item.button else { return }
    b.imagePosition = .imageLeading
    setStatus(icon: Config.menuBarIcon, title: Config.menuBarTitle)
    b.target = self
    b.action = #selector(statusClicked)
    b.sendAction(on: [.leftMouseUp, .rightMouseUp])
  }

  func setStatus(icon: String?, title: String?) {
    guard let b = statusItem?.button else { return }
    if let icon {
      let img = icon.isEmpty ? nil : NSImage(systemSymbolName: icon, accessibilityDescription: Config.name)
      img?.isTemplate = true
      b.image = img
    }
    if let title {
      // A space keeps the text off the icon.
      b.title = title.isEmpty || b.image == nil ? title : " " + title
    }
    // Never leave the item empty: it would vanish from the menu bar.
    if b.image == nil && b.title.isEmpty { b.title = Config.name }
  }

  @objc func statusClicked() {
    let e = NSApp.currentEvent
    if e?.type == .rightMouseUp || e?.modifierFlags.contains(.control) == true {
      statusMenu().popUp(positioning: nil, at: NSPoint(x: 0, y: -4), in: statusItem?.button)
      return
    }
    // The click that hid the panel (it lost focus) also lands here.
    if Date().timeIntervalSince(panelHidAt) < 0.25 { return }
    togglePanel()
  }

  /// A right-click: the panel has no app menu to quit from.
  func statusMenu() -> NSMenu {
    let m = NSMenu()
    m.addItem(withTitle: "Open \(Config.name)", action: #selector(showPanel), keyEquivalent: "").target = self
    if updater != nil {
      m.addItem(withTitle: "Check for Updates…", action: #selector(checkForUpdates), keyEquivalent: "").target = self
    }
    m.addItem(.separator())
    m.addItem(withTitle: "Quit \(Config.name)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
    return m
  }

  func togglePanel() {
    if window.isVisible { hidePanel() } else { showPanel() }
  }

  @objc func showPanel() {
    if !panelOpened {
      panelOpened = true
      pendingLoad?()
      pendingLoad = nil
    }
    place()
    if quietTest {
      window.orderFrontRegardless()
      window.makeKey()
    } else {
      NSApp.activate(ignoringOtherApps: true)
      window.makeKeyAndOrderFront(nil)
    }
    window.makeFirstResponder(web)
    emitMenuBarOpen(MenuBarOpen(open: true))
  }

  func hidePanel() {
    guard window.isVisible else { return }
    window.orderOut(nil)
    panelHidAt = Date()
    emitMenuBarOpen(MenuBarOpen(open: false))
  }

  @objc func panelResigned() {
    // A sheet (a file panel) or an alert takes key but belongs to the panel.
    if window.attachedSheet != nil || NSApp.modalWindow != nil { return }
    hidePanel()
  }

  /// Under the status item, kept on its screen.
  func place() {
    let size = window.frame.size
    guard let b = statusItem?.button, let bw = b.window else {
      return window.center()
    }
    let r = bw.convertToScreen(b.convert(b.bounds, to: nil))
    let vis = (bw.screen ?? NSScreen.main)?.visibleFrame ?? r
    // Right after launch the menu bar hasn't placed the item yet: go top
    // right for now, and under the item once it has a place.
    if r.maxY < vis.maxY {
      window.setFrameOrigin(NSPoint(x: vis.maxX - size.width - 8, y: vis.maxY - size.height - 6))
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
        if self?.window.isVisible == true { self?.place() }
      }
      return
    }
    var x = r.midX - size.width / 2
    x = min(max(x, vis.minX + 8), vis.maxX - size.width - 8)
    window.setFrameOrigin(NSPoint(x: x, y: r.minY - size.height - 6))
  }

  func menuBarSet(_ a: MenuBarSet) { setStatus(icon: a.icon, title: a.title) }

  func menuBarClose() { hidePanel() }
}
