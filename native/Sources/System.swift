// The Mac's state, for sync pacing (core/pacing.ts): asleep, online, Low
// Power Mode. Sent to the core when the link opens and on every change.

import AppKit
import Network

final class SystemWatch {
  private(set) var state = SystemState(asleep: false, online: true, lowPower: false)
  var onChange: ((SystemState) -> Void)?
  private let path = NWPathMonitor()
  private var tokens: [NSObjectProtocol] = []

  init() {
    state.lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
    let ws = NSWorkspace.shared.notificationCenter
    tokens.append(
      ws.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) {
        [weak self] _ in self?.set { $0.asleep = true }
      })
    tokens.append(
      ws.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) {
        [weak self] _ in self?.set { $0.asleep = false }
      })
    tokens.append(
      NotificationCenter.default.addObserver(
        forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main
      ) { [weak self] _ in
        self?.set { $0.lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled }
      })
    path.pathUpdateHandler = { [weak self] p in
      DispatchQueue.main.async { self?.set { $0.online = p.status == .satisfied } }
    }
    path.start(queue: .global(qos: .utility))
  }

  /// For tests: act as if these notifications came in.
  func fake(asleep: Bool?, online: Bool?, lowPower: Bool?) {
    set {
      if let asleep { $0.asleep = asleep }
      if let online { $0.online = online }
      if let lowPower { $0.lowPower = lowPower }
    }
  }

  private func set(_ f: (inout SystemState) -> Void) {
    var s = state
    f(&s)
    guard s.asleep != state.asleep || s.online != state.online || s.lowPower != state.lowPower
    else { return }
    state = s
    log("system: asleep=\(s.asleep) online=\(s.online) lowPower=\(s.lowPower)")
    onChange?(s)
  }

  /// The event the core reads: {"ev":"system", ...state}.
  var event: [String: Any] {
    ["ev": "system", "asleep": state.asleep, "online": state.online, "lowPower": state.lowPower]
  }
}
