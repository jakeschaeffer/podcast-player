import AVFoundation
import Foundation
import SnipCore
import Speech

/// Apple's on-device speech recognition (`SpeechAnalyzer` with a `SpeechTranscriber`, iOS 26 and macOS 26): free,
/// private, and nothing leaves the phone. Measured on hour-long English podcasts at about 68 times real time on a
/// Mac, with words within about 150 ms of ElevenLabs'. It labels no speakers and tags no sounds, so the transcript
/// has neither (`spk` null, no events) and ad detection works from sponsor phrases and pauses alone.
///
/// The locale's model is installed with `AssetInventory` the first time it is needed (a download by the system).
public struct AppleSpeechTranscriber: Transcriber {
  public let name = "apple"
  public let model = "speechtranscriber"

  public init() {}

  public func transcribe(file: URL, language: String?) async throws -> RawTranscript {
    let code = language ?? "en"
    guard SpeechTranscriber.isAvailable else { throw TranscriberError("speech recognition is not available on this device") }
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: code)) else {
      throw TranscriberError("speech recognition does not support the language '\(code)'")
    }
    let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      try await request.downloadAndInstall()
    }
    let audio = try AVAudioFile(forReading: file)
    let durationMs = audio.fileFormat.sampleRate > 0 ? Double(audio.length) / audio.fileFormat.sampleRate * 1000 : nil
    let analyzer = SpeechAnalyzer(modules: [transcriber])

    // Results are read while the file is analyzed; with no volatile results asked for, each one is final.
    let words = Task { () throws -> [RawWord] in
      var words: [RawWord] = []
      for try await result in transcriber.results {
        words += Self.words(in: result.text)
      }
      return words
    }
    do {
      if let last = try await analyzer.analyzeSequence(from: audio) {
        try await analyzer.finalizeAndFinish(through: last)
      } else {
        await analyzer.cancelAndFinishNow()
      }
    } catch {
      await analyzer.cancelAndFinishNow()
      words.cancel()
      throw error
    }
    return RawTranscript(provider: name, model: model, language: code, words: try await words.value, durationMs: durationMs)
  }

  /// Each run of the result's text that carries a time range is one word: its text trimmed, its times in ms.
  static func words(in text: AttributedString) -> [RawWord] {
    text.runs.compactMap { run in
      let word = String(text[run.range].characters).trimmingCharacters(in: .whitespacesAndNewlines)
      guard !word.isEmpty, let range = run.audioTimeRange else { return nil }
      return RawWord(text: word, startMs: range.start.seconds * 1000, endMs: range.end.seconds * 1000)
    }
  }
}
