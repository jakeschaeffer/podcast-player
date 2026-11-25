import CryptoKit
import Foundation
import SnipCore

// The transcription job: the server's `fetch_audio` (server/src/services/episodes.ts, `fetchAudioJob`) and
// `transcribe` (services/transcripts.ts, `transcribeJob`) as one job, since the phone fetches a recording only to
// transcribe it. The file is downloaded first and that file is transcribed and then played, because inserted ads
// differ between fetches and a transcript's times are positions in one file.

/// What a transcription job needs to know about its asset.
struct TranscriptionSource: Sendable {
  let asset: AssetRow
  let enclosureUrl: String
  let language: String?
  let file: URL?
  let transcribed: Bool
}

extension Store {
  func transcriptionSource(assetId: String) throws -> TranscriptionSource {
    let asset = try assetRow(assetId)
    let episode = try episodeRow(asset.episodeId)
    let feed = try feedRow(episode.feedId)
    return TranscriptionSource(
      asset: asset, enclosureUrl: episode.enclosureUrl, language: languageCode(feed.language), file: audioFile(asset),
      transcribed: try hasSpeechTranscript(assetId: assetId))
  }

  /// The recording is on the phone: the asset's numbers become the file's. The asset keeps its id, where the server
  /// makes a new asset for its download and carries the place across when the lengths agree within a second
  /// (`carryPlace`). The phone's asset was never a file it measured, so there is no other recording to keep apart,
  /// and the place heard so far stays as it was, on what may have been a different cut of the stream.
  func recordAudioFile(assetId: String, path: String, bytes: Int, durationMs: Int, sha256: String) throws {
    try db.run("UPDATE audio_asset SET path = ?, bytes = ?, duration_ms = ?, sha256 = ? WHERE id = ?", [path, bytes, durationMs, sha256, assetId])
  }

  /// Store what the transcriber heard, if the job is still this process's: `normalize` against the file's length,
  /// `storeTranscript`, then the job is done. A transcript already there (asked for twice) is kept and this one
  /// dropped, as the server's job returns early when one exists.
  func finishTranscription(_ job: ClaimedJob, _ raw: RawTranscript) throws {
    guard try holds(job) else { return }
    if try !hasSpeechTranscript(assetId: job.assetId) {
      let asset = try assetRow(job.assetId)
      let normalized = try normalize(raw, options: NormalizeOptions(durationMs: asset.durationMs > 0 ? asset.durationMs : nil))
      try storeTranscript(assetId: job.assetId, normalized, costCents: raw.costCents, providerRequestId: raw.providerRequestId)
    }
    try completeJob(job)
  }
}

extension LocalBackend {
  /// Run queued jobs until none is left, one at a time.
  func drainJobs() async {
    while let job = try? await store.claimTranscription() {
      host.begin(job.id)
      await transcribe(job)
      host.end(job.id)
    }
  }

  /// Start the runner if it is idle.
  func kickJobs() {
    guard startsJobs else { return }
    Task { await jobs.kick { [self] in await drainJobs() } }
  }

  private func transcribe(_ job: ClaimedJob) async {
    let started = Date()
    do {
      let source = try await store.transcriptionSource(assetId: job.assetId)
      if source.transcribed {
        try await store.completeJob(job)
        return
      }
      var file = source.file
      if file == nil { file = try await download(source) }
      guard let file else { return }
      guard try await store.holds(job) else { return }
      let raw = try await transcriber.transcribe(file: file, language: source.language ?? "en")
      try await store.finishTranscription(job, raw)
      Self.log.info(
        "transcript stored for \(job.assetId, privacy: .public): \(raw.words.count) words in \(Int(Date().timeIntervalSince(started)), privacy: .public) s")
    } catch {
      let message = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
      Self.log.error("transcription failed for \(job.assetId, privacy: .public): \(message, privacy: .public)")
      try? await store.failJob(job, message)
    }
  }

  /// Download the enclosure to `audio/<asset id>.<ext>`, measure and hash it, and record it on the asset
  /// (`fetchAudioJob`). A failed or truncated download leaves no file behind.
  private func download(_ source: TranscriptionSource) async throws -> URL {
    let asset = source.asset
    guard let request = Self.request(source.enclosureUrl, accept: "audio/*,*/*", timeout: 120) else {
      throw TranscriberError("the recording's address is not a URL")
    }
    let folder = store.folder.appending(path: "audio")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let name = "\(asset.id)\(Self.extensionFor(mime: asset.mime, url: source.enclosureUrl))"
    let file = folder.appending(path: name)
    do {
      let response = try await downloader.download(request, to: file)
      guard response.statusCode == 200 else { throw TranscriberError("enclosure returned \(response.statusCode)") }
      let bytes = (try FileManager.default.attributesOfItem(atPath: file.path(percentEncoded: false))[.size] as? NSNumber)?.intValue ?? 0
      if let declared = response.value(forHTTPHeaderField: "Content-Length").flatMap(Int.init), declared > 0, declared != bytes {
        throw TranscriberError("download truncated: \(bytes) of \(declared) bytes")
      }
      let durationMs = try await durations.durationMs(of: file)
      try await store.recordAudioFile(assetId: asset.id, path: "audio/\(name)", bytes: bytes, durationMs: durationMs, sha256: try Self.sha256(of: file))
      Self.log.info("audio stored for \(asset.id, privacy: .public): \(bytes) bytes, \(durationMs) ms")
      return file
    } catch {
      try? FileManager.default.removeItem(at: file)
      throw error
    }
  }

  static func sha256(of file: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: file)
    defer { try? handle.close() }
    var hash = SHA256()
    while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty { hash.update(data: chunk) }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
  }

  /// `extensionFor` (server/src/services/episodes.ts), from the feed's type where the server has the file's: the
  /// extension is how AVFoundation tells the file's format.
  static func extensionFor(mime: String, url: String) -> String {
    if mime == "audio/mpeg" { return ".mp3" }
    if mime.hasPrefix("audio/mp4") { return ".m4a" }
    if mime.hasPrefix("audio/ogg") { return ".ogg" }
    if mime == "audio/wav" { return ".wav" }
    if mime == "audio/flac" { return ".flac" }
    if mime == "audio/aac" { return ".aac" }
    let fromUrl = URL(string: url).map { "." + $0.pathExtension.lowercased() } ?? ""
    return fromUrl.range(of: "^\\.[a-z0-9]{2,5}$", options: .regularExpression) != nil ? fromUrl : ".bin"
  }
}
