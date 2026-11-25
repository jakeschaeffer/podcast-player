import AVFoundation
import Foundation
import SnipCore

/// Speech to words with times, on the phone. `LocalBackend` hands it the recording it downloaded (the same file the
/// player then plays) and stores what comes back as the server stores a provider's answer: `normalize`d, then
/// segments. The default is `AppleSpeechTranscriber`; tests pass a fake.
public protocol Transcriber: Sendable {
  /// What `transcript.provider` records (the server's is `elevenlabs`).
  var name: String { get }
  /// What `transcript.model` records.
  var model: String { get }
  /// The words of `file`, times in milliseconds from its start. `language` is an ISO 639 code (`en`), the show's
  /// when its feed says, else `en`. Throws when the language cannot be transcribed here, or the file cannot be read.
  func transcribe(file: URL, language: String?) async throws -> RawTranscript
}

/// Why a transcription could not happen; the message is the job's `last_error`.
public struct TranscriberError: Error, LocalizedError, Equatable {
  public let message: String
  public init(_ message: String) { self.message = message }
  public var errorDescription: String? { message }
}

/// Fetches a recording to a file. URLSession's download task writes straight to disk; the `HTTPTransport` that
/// feeds come through holds a whole body in memory, which an hour of audio should not be.
public protocol Downloader: Sendable {
  /// Download `request` to `file` (replacing anything there) and return the response. A response that is not a
  /// 200 is returned as it is, for the caller to judge; it may have left a file behind, which the caller removes.
  func download(_ request: URLRequest, to file: URL) async throws -> HTTPURLResponse
}

/// The system's: `URLSession.download(for:)`, then moved into place before the temporary file can go.
public struct URLSessionDownloader: Downloader {
  let session: URLSession

  public init(session: URLSession = .shared) { self.session = session }

  public func download(_ request: URLRequest, to file: URL) async throws -> HTTPURLResponse {
    let (temporary, response) = try await session.download(for: request)
    guard let http = response as? HTTPURLResponse else {
      try? FileManager.default.removeItem(at: temporary)
      throw URLError(.badServerResponse)
    }
    try? FileManager.default.removeItem(at: file)
    try FileManager.default.moveItem(at: temporary, to: file)
    return http
  }
}

/// How long a recording is. The feed's figure is a claim (often absent, and short of the file wherever ads are
/// inserted); a transcript's times and the player's end are the file's, so the file is measured once it is here.
public protocol DurationProbe: Sendable {
  func durationMs(of file: URL) async throws -> Int
}

/// AVFoundation's measure of the file (`AVURLAsset.load(.duration)`), the phone's ffprobe.
public struct AVDurationProbe: DurationProbe {
  public init() {}

  public func durationMs(of file: URL) async throws -> Int {
    let duration = try await AVURLAsset(url: file).load(.duration)
    guard duration.isNumeric, duration.seconds.isFinite, duration.seconds > 0 else {
      throw TranscriberError("the recording has no length that can be read")
    }
    return Int((duration.seconds * 1000).rounded())
  }
}
