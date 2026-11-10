import AppKit
import SwiftUI

// The Settings window: a SwiftUI form, grouped like System Settings. The
// page owns the values. It sends them on open, and gets each change back
// as a settings.changed event. In a tab, the page shows an HTML dialog.
final class SettingsModel: ObservableObject {
  @Published var v: TodoSettings
  let changed: (TodoSettings) -> Void
  init(_ v: TodoSettings, changed: @escaping (TodoSettings) -> Void) {
    self.v = v
    self.changed = changed
  }
  func binding<T>(_ k: WritableKeyPath<TodoSettings, T>) -> Binding<T> {
    Binding(get: { self.v[keyPath: k] }, set: { self.v[keyPath: k] = $0; self.changed(self.v) })
  }
}

struct SettingsView: View {
  @ObservedObject var m: SettingsModel
  let aiReady: Bool

  var body: some View {
    Form {
      Section {
        Toggle("Show count in menu bar", isOn: m.binding(\.showCount))
        Toggle("Show completed to-dos", isOn: m.binding(\.showCompleted))
        Toggle("Tap the trackpad on check-off", isOn: m.binding(\.haptics))
      } header: {
        Label("List", systemImage: "checklist")
      }
      Section {
        Picker("Remind me in", selection: m.binding(\.remindIn)) {
          ForEach([15, 30, 60, 120, 240], id: \.self) { Text(Self.minutes($0)).tag($0) }
        }
        Picker("Snooze for", selection: m.binding(\.snooze)) {
          ForEach([5, 10, 15, 30, 60], id: \.self) { Text(Self.minutes($0)).tag($0) }
        }
      } header: {
        Label("Reminders", systemImage: "bell")
      } footer: {
        Text("Reminders show as notifications, with Mark as Done and Snooze.")
          .foregroundStyle(.secondary)
      }
      Section {
        LabeledContent("Break into steps") {
          Label(aiReady ? "On this Mac" : "Not available",
                systemImage: aiReady ? "checkmark.circle.fill" : "xmark.circle")
            .foregroundStyle(aiReady ? .green : .secondary)
        }
      } header: {
        Label("Apple Intelligence", systemImage: "sparkles")
      } footer: {
        Text(aiReady
             ? "Steps come from the on-device model. Nothing leaves your Mac."
             : "Needs macOS 26 with Apple Intelligence turned on.")
          .foregroundStyle(.secondary)
      }
    }
    .formStyle(.grouped)
    .frame(width: 420)
    .fixedSize(horizontal: false, vertical: true)
  }

  static func minutes(_ m: Int) -> String {
    m < 60 ? "\(m) minutes" : m == 60 ? "1 hour" : "\(m / 60) hours"
  }
}

extension Shell {
  private static var settingsWindow: NSWindow?

  func settingsOpen(_ a: TodoSettings) {
    let model = SettingsModel(a) { [weak self] v in self?.emitSettingsChanged(v) }
    let view = SettingsView(m: model, aiReady: aiAvailable())
    let w: NSWindow
    if let old = Self.settingsWindow {
      w = old
      w.contentViewController = NSHostingController(rootView: view)
    } else {
      w = NSWindow(contentViewController: NSHostingController(rootView: view))
      w.title = "\(Config.name) Settings"
      w.styleMask = [.titled, .closable]
      w.isReleasedWhenClosed = false
      w.center()
      Self.settingsWindow = w
    }
    // A menu bar app is never active on its own: bring it forward.
    NSApp.activate()
    w.makeKeyAndOrderFront(nil)
    w.orderFrontRegardless()
  }
}
