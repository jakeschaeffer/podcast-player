#if DEBUG
  import Foundation
  import OnDevice
  import SnipCore

  /// `-transcriptFixtures <folder>` (DEBUG): the simulator has no speech model, so the phone's transcription job hands
  /// its downloaded file to this instead, which waits for `<folder>/<file name>.json` and reads the words from it.
  /// A script on the Mac transcribes that same downloaded file with Apple's model and writes the JSON, so everything
  /// after the speech step (storing, ad breaks, the screens) runs for real on real words.
  struct FixtureTranscriber: Transcriber {
    let folder: URL
    let name = "apple"
    let model = "speechtranscriber"

    private struct Fixture: Decodable {
      struct Word: Decodable {
        let text: String
        let start_ms: Double
        let end_ms: Double
      }
      let words: [Word]
    }

    func transcribe(file: URL, language: String?) async throws -> RawTranscript {
      let fixture = folder.appending(path: file.lastPathComponent + ".json")
      for _ in 0..<600 where !FileManager.default.fileExists(atPath: fixture.path(percentEncoded: false)) {
        try await Task.sleep(for: .seconds(1))
      }
      let words = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: fixture)).words
      return RawTranscript(
        provider: name, model: model, language: language ?? "en",
        words: words.map { RawWord(text: $0.text, startMs: $0.start_ms, endMs: $0.end_ms, speaker: nil, confidence: nil) },
        events: [], durationMs: nil, costCents: nil, providerRequestId: nil)
    }
  }
#endif
