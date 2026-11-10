// The window's toolbar, from `toolbar` in the app's config. Each button
// sends `menu.command { id }` to the page, as a menu item does, so the
// page handles both with one `native.command(id, …)`.

import AppKit

enum ToolbarItemSpec {
  /// A flexible space.
  case space
  /// Title, command id, SF Symbol.
  case button(String, String, String)
}

final class Toolbar: NSObject, NSToolbarDelegate {
  let run: (String) -> Void
  private var ids: [NSToolbarItem.Identifier] = []
  private var specs: [NSToolbarItem.Identifier: (String, String, String)] = [:]

  init(_ items: [ToolbarItemSpec], run: @escaping (String) -> Void) {
    self.run = run
    super.init()
    for it in items {
      switch it {
      case .space: ids.append(.flexibleSpace)
      case .button(let title, let cmd, let sym):
        let id = NSToolbarItem.Identifier("cmd." + cmd)
        ids.append(id)
        specs[id] = (title, cmd, sym)
      }
    }
  }

  func toolbarDefaultItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { ids }
  func toolbarAllowedItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { ids }

  func toolbar(
    _ t: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar: Bool
  ) -> NSToolbarItem? {
    guard let (title, _, sym) = specs[id] else { return nil }
    let it = NSToolbarItem(itemIdentifier: id)
    it.label = title
    it.toolTip = title
    it.image = NSImage(systemSymbolName: sym, accessibilityDescription: title)
    it.isBordered = true
    it.target = self
    it.action = #selector(click(_:))
    return it
  }

  @objc func click(_ it: NSToolbarItem) {
    if let (_, cmd, _) = specs[it.itemIdentifier] { run(cmd) }
  }
}

extension Shell {
  func buildToolbar() {
    guard !Config.toolbar.isEmpty else { return }
    toolbarDelegate = Toolbar(Config.toolbar) { [weak self] id in
      guard let self else { return }
      if self.window.firstResponder !== self.web { self.window.makeFirstResponder(self.web) }
      self.emitMenuCommand(MenuCommand(id: id))
    }
    let t = NSToolbar(identifier: "main")
    t.delegate = toolbarDelegate
    t.displayMode = .iconOnly
    window.toolbar = t
    window.toolbarStyle = .unified
  }
}
