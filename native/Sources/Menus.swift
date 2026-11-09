// The menu bar, built from steambun.config.ts (Config.gen.swift).
//
// The app menu and Edit are always there; without Edit, ⌘C/⌘V/⌘A do
// nothing in a WKWebView. The app's own menus come next, then Window and
// Help. A command item sends `menu.command { id }` to the page.

import AppKit

enum MenuRole {
  case about, updates, hide, hideOthers, showAll, quit
  case undo, redo, cut, copy, paste, selectAll
  case reload, fullscreen, minimize, zoom, close
}

enum MenuItemSpec {
  case separator
  case role(MenuRole)
  /// Title, command id, default key ("" for none).
  case command(String, String, String)
}

extension Shell {
  func buildMenu() {
    let main = NSMenu()
    let name = Config.name
    func sub(_ title: String, _ specs: [MenuItemSpec]) {
      let it = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      let m = NSMenu(title: title)
      specs.map(make).forEach(m.addItem)
      it.submenu = m
      main.addItem(it)
    }
    sub(name, [.role(.about), .role(.updates)] + Config.appMenu + [.separator, .role(.hide), .role(.hideOthers), .role(.showAll), .separator, .role(.quit)])
    sub("Edit", [.role(.undo), .role(.redo), .separator, .role(.cut), .role(.copy), .role(.paste), .role(.selectAll)])
    for (title, specs) in Config.menus { sub(title, specs) }
    sub("Window", [.role(.minimize), .role(.zoom), .role(.close)] + (Config.windowMenu.isEmpty ? [] : [.separator] + Config.windowMenu))
    if !Config.helpMenu.isEmpty { sub("Help", Config.helpMenu) }
    NSApp.mainMenu = main
    // Defaults until the page sends its key map.
    applyKeys(defaultKeys)
  }

  private func make(_ s: MenuItemSpec) -> NSMenuItem {
    func item(_ t: String, _ a: Selector?, _ k: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let i = NSMenuItem(title: t, action: a, keyEquivalent: k)
      i.keyEquivalentModifierMask = mods
      return i
    }
    let name = Config.name
    switch s {
    case .separator: return .separator()
    case .command(let title, let id, let key):
      let i = NSMenuItem(title: title, action: #selector(runCommand(_:)), keyEquivalent: "")
      i.representedObject = id
      commandItems[id] = i
      if !key.isEmpty { defaultKeys[id] = [key] }
      return i
    case .role(let r):
      switch r {
      case .about: return item("About \(name)", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), "")
      case .updates:
        updateItem = item("Check for Updates…", #selector(checkForUpdates), "")
        return updateItem
      case .hide: return item("Hide \(name)", #selector(NSApplication.hide(_:)), "h")
      case .hideOthers: return item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option])
      case .showAll: return item("Show All", #selector(NSApplication.unhideAllApplications(_:)), "")
      case .quit: return item("Quit \(name)", #selector(NSApplication.terminate(_:)), "q")
      case .undo: return item("Undo", Selector(("undo:")), "z")
      case .redo: return item("Redo", Selector(("redo:")), "z", [.command, .shift])
      case .cut: return item("Cut", #selector(NSText.cut(_:)), "x")
      case .copy: return item("Copy", #selector(NSText.copy(_:)), "c")
      case .paste: return item("Paste", #selector(NSText.paste(_:)), "v")
      case .selectAll: return item("Select All", #selector(NSText.selectAll(_:)), "a")
      case .reload: return item("Reload Page", #selector(reload), "r", [.command, .option])
      case .fullscreen: return item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])
      case .minimize: return item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")
      case .zoom: return item("Zoom", #selector(NSWindow.performZoom(_:)), "")
      case .close: return item("Close", #selector(NSWindow.performClose(_:)), "w")
      }
    }
  }

  @objc func reload() { web.reload() }

  @objc func runCommand(_ sender: NSMenuItem) {
    guard let id = sender.representedObject as? String else { return }
    // From a browser page, the command acts on the app: give it the keys.
    if window.firstResponder !== web { window.makeFirstResponder(web) }
    emitMenuCommand(MenuCommand(id: id))
  }

  /// Show each command's first chord as its menu key.
  func applyKeys(_ map: [String: [String]]) {
    for (id, item) in commandItems {
      let k = (map[id] ?? []).lazy.compactMap(menuKey).first
      item.keyEquivalent = k?.0 ?? ""
      item.keyEquivalentModifierMask = k?.1 ?? []
    }
  }
}

/// "mod+shift+k" → ("k", [.command, .shift]). Nil for keys a menu can't show.
func menuKey(_ combo: String) -> (String, NSEvent.ModifierFlags)? {
  var parts = combo == "+" ? ["+"] : combo.components(separatedBy: "+")
  if combo.hasSuffix("++") { parts = combo.dropLast(2).components(separatedBy: "+") + ["+"] }
  guard let key = parts.popLast() else { return nil }
  var mods: NSEvent.ModifierFlags = []
  for m in parts {
    switch m {
    case "mod": mods.insert(.command)
    case "ctrl": mods.insert(.control)
    case "alt": mods.insert(.option)
    case "shift": mods.insert(.shift)
    default: return nil
    }
  }
  let named: [String: Int] = [
    "Enter": 0x0D, "Escape": 0x1B, "Backspace": 0x08, "Delete": NSDeleteFunctionKey, "Tab": 0x09,
    "ArrowUp": NSUpArrowFunctionKey, "ArrowDown": NSDownArrowFunctionKey,
    "ArrowLeft": NSLeftArrowFunctionKey, "ArrowRight": NSRightArrowFunctionKey, "Space": 0x20,
  ]
  if let n = named[key], let u = UnicodeScalar(n) { return (String(Character(u)), mods) }
  return key.count == 1 ? (key.lowercased(), mods) : nil
}
