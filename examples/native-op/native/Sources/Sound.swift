import AppKit

// The Swift side of native/bridge.ts. Leave a method out and the build
// fails, and the error names the missing method.
extension Shell {
  func soundPlay(_ a: SoundPlayArgs) -> Bool {
    // A named sound is shared, and play() fails while it still plays.
    guard let s = NSSound(named: a.name) else { return false }
    s.stop()
    return s.play()
  }
}
