import Foundation

/// Points where an app's Swift code joins the shell's life. Each has a
/// default that does nothing. To use one, write the same method in an
/// `extension Shell { … }` in your own Swift file; the shell calls yours.
protocol ShellHooks {
  /// At launch, before the menus and the window exist.
  func appWillLaunch()
  /// Extra state for `app.state()` in native tests.
  func appTestState() -> [String: String]
}

extension ShellHooks {
  func appWillLaunch() {}
  func appTestState() -> [String: String] { [:] }
}

extension Shell: ShellHooks {}
