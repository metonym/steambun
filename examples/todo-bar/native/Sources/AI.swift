import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

// Apple Intelligence's on-device model (macOS 26+). It runs on the Mac,
// so it needs no network and no key. On an older Mac, or with Apple Intelligence off,
// ai.available is false and the page hides the button. An SDK older than
// macOS 26 has no FoundationModels, so the app builds without it.
extension Shell {
  func aiAvailable() -> Bool {
    #if canImport(FoundationModels)
    guard #available(macOS 26, *) else { return false }
    return SystemLanguageModel.default.availability == .available
    #else
    return false
    #endif
  }

  func aiSteps(_ a: AiStepsArgs) async throws -> [String] {
    #if canImport(FoundationModels)
    guard #available(macOS 26, *) else { throw BridgeError("needs macOS 26") }
    let s = LanguageModelSession(instructions: """
      You split a to-do into 2 to 6 short, concrete steps. \
      Write one step per line, each under 8 words, starting with a verb. \
      No numbers, bullets, headings or extra text.
      """)
    let r = try await s.respond(to: a.text)
    return r.content
      .split(whereSeparator: \.isNewline)
      .map { $0.trimmingCharacters(in: .whitespaces) }
      // Models number lines anyway now and then.
      .map { $0.replacingOccurrences(of: #"^([-*•]|\d+[.)])\s*"#, with: "", options: .regularExpression) }
      .map { $0.hasSuffix(".") ? String($0.dropLast()) : $0 }
      .filter { !$0.isEmpty }
      .prefix(6)
      .map { $0 }
    #else
    throw BridgeError("needs the macOS 26 SDK")
    #endif
  }
}
