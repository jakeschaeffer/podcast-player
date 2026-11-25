import Foundation
import PodcastAPI
import SnipCore
import Testing

@testable import OnDevice

/// The real recognizer, on a file named by `SNIP_SPEECH_TEST_AUDIO` (an English recording; nothing is played).
/// Skipped otherwise, so the normal run needs neither a file nor the system's speech model. To make a clip that never
/// reaches the speakers: `say -o /tmp/clip.aiff "The tide was turning as we left the harbour."`.
struct AppleSpeechTranscriberTests {
  static let audio = ProcessInfo.processInfo.environment["SNIP_SPEECH_TEST_AUDIO"]

  @Test(.enabled(if: audio != nil, "set SNIP_SPEECH_TEST_AUDIO to an English audio file"))
  func itHearsWordsWithTimes() async throws {
    let file = URL(filePath: try #require(Self.audio))
    let raw = try await AppleSpeechTranscriber().transcribe(file: file, language: "en")
    #expect(raw.provider == "apple" && raw.model == "speechtranscriber" && raw.language == "en")
    #expect(!raw.words.isEmpty)
    #expect(raw.words.allSatisfy { !$0.text.isEmpty && $0.text == $0.text.trimmingCharacters(in: .whitespacesAndNewlines) })
    #expect(raw.words.allSatisfy { $0.startMs >= 0 && $0.endMs >= $0.startMs })
    #expect(zip(raw.words, raw.words.dropFirst()).allSatisfy { $0.startMs <= $1.startMs })
    let duration = try #require(raw.durationMs)
    #expect(raw.words.last!.endMs <= duration + 500)
    // It stores as any transcript does.
    let normalized = try normalize(raw, options: NormalizeOptions(durationMs: Int(duration)))
    #expect(normalized.wordCount == raw.words.count)
    print("heard:", raw.words.map(\.text).joined(separator: " "))
  }

  /// The whole job with the real recognizer and AVFoundation's measure: the file is "downloaded" by copying it.
  @Test(.enabled(if: audio != nil, "set SNIP_SPEECH_TEST_AUDIO to an English audio file"))
  func theJobTranscribesAndMeasuresARealFile() async throws {
    let source = URL(filePath: try #require(Self.audio))
    let ext = source.pathExtension
    let enclosure = "https://media.example.com/clip.\(ext)"
    let http = StubHTTP()
    http.serve(
      "https://feeds.example.com/clip.xml",
      rss(title: "Clip", items: [TestItem(title: "Clip", guid: "c-1", url: enclosure, type: ext == "mp3" ? "audio/mpeg" : "audio/\(ext)")]))
    let folder = FileManager.default.temporaryDirectory.appending(path: "ondevice-speech-\(UUID().uuidString)")
    let backend = try LocalBackend(
      folder: folder, deviceName: "Test Phone", http: http, now: { Date() }, transcriber: AppleSpeechTranscriber(),
      downloader: CopyingDownloader(source: source), durations: AVDurationProbe(), host: JobHost(), startsJobs: false)
    let api = APIClient(baseURL: URL(string: "http://phone.invalid")!, transport: backend, token: { nil })
    _ = try await api.createFeed(CreateFeed(url: "https://feeds.example.com/clip.xml"))
    let episode = try await api.episodes().items[0]
    _ = try await api.processEpisode(episode.id)
    await backend.drainJobs()
    let detail = try await api.episode(episode.id)
    #expect(detail.processing.transcript == .ready)
    #expect(detail.asset?.audioUrl.hasPrefix("file://") == true)
    #expect((detail.asset?.durationMs ?? 0) > 0)
    let transcript = try await api.transcript(try #require(detail.transcriptId))
    #expect(transcript.wordCount > 0)
    print("measured:", detail.asset?.durationMs ?? 0, "ms,", transcript.wordCount, "words")
  }

  @Test(.enabled(if: audio != nil, "set SNIP_SPEECH_TEST_AUDIO to an English audio file"))
  func aLanguageItCannotHearFailsClearly() async throws {
    let file = URL(filePath: try #require(Self.audio))
    let error = await #expect(throws: TranscriberError.self) { try await AppleSpeechTranscriber().transcribe(file: file, language: "zz") }
    #expect(error == TranscriberError("speech recognition does not support the language 'zz'"))
  }
}

/// "Downloads" a local file by copying it.
struct CopyingDownloader: Downloader {
  let source: URL

  func download(_ request: URLRequest, to file: URL) async throws -> HTTPURLResponse {
    try? FileManager.default.removeItem(at: file)
    try FileManager.default.copyItem(at: source, to: file)
    return HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [:])!
  }
}
