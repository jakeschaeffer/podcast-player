import Foundation
import Synchronization

// A port of the parts of server/src/jobs/queue.ts that transcription uses: durable jobs in the `job` table, one per
// key, enqueued idempotently, claimed in priority order. The phone has one kind of job (`transcribe`) and one process,
// so what the server needs for many workers (leases, heartbeats, backoff) is left out, and each place says so.

/// The server's priorities (`PRIORITY` in jobs/queue.ts), the two the phone uses.
enum JobPriority {
  /// The listener asked for this episode (Transcribe): the server's `play`.
  static let asked = 50
  /// Playing an untranscribed episode queues it. The server queues that at `play` too, but there only for
  /// `auto_process` shows; on the phone every show is transcribed when played, so an episode asked for goes ahead
  /// of the ones that were merely played (the server's `upNext`).
  static let played = 25
}

/// A job this process claimed. `attempts` after the claim is its token: a write for the job is made only while the row
/// is still `running` with that count, so a job given up and taken again (by a later launch on the same folder)
/// cannot be finished twice.
struct ClaimedJob: Sendable, Equatable {
  let id: String
  let assetId: String
  let attempts: Int
}

extension Store {
  static let transcribeKind = "transcribe"
  /// Launches that may find the same job interrupted before it is given up. The server retries a job five times
  /// with backoff; on the phone an interruption is the app being ended, and a job that keeps ending it (memory, a
  /// crash in the recognizer) must not do so at every launch for ever.
  static let maxAttempts = 3

  static func transcribeKey(_ assetId: String) -> String { "\(transcribeKind):\(assetId)" }

  /// `JobQueue.enqueue`: a second enqueue of the same key is a no-op, except that a higher priority is adopted and a
  /// failed job is queued again (with its attempts reset), which is how Transcribe retries. Returns whether the job
  /// is now waiting to run.
  @discardableResult
  func enqueueTranscription(assetId: String, priority: Int) throws -> Bool {
    let now = now()
    let key = Self.transcribeKey(assetId)
    let payload = String(decoding: JSON.object(["asset_id": .string(assetId)]).data(), as: UTF8.self)
    if let existing = try db.get("SELECT id, status, priority FROM job WHERE key = ?", [key]) {
      let status = existing.string("status")
      if status == "failed" || status == "deferred" {
        try db.run(
          "UPDATE job SET status = 'queued', payload = ?, priority = MAX(priority, ?), run_after = ?, attempts = 0, last_error = NULL, updated_at = ? WHERE id = ?",
          [payload, priority, now, now, existing.string("id")])
        return true
      }
      if priority > existing.int("priority") ?? 0 {
        try db.run("UPDATE job SET priority = ?, updated_at = ? WHERE id = ?", [priority, now, existing.string("id")])
      }
      return status == "queued"
    }
    try db.run(
      "INSERT INTO job (id, kind, key, payload, priority, status, attempts, run_after, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)",
      [newId(), Self.transcribeKind, key, payload, priority, now, now, now])
    return true
  }

  /// `JobQueue.claim`: the next queued job, highest priority first, then oldest. No lease: nothing else in this
  /// process claims jobs, and a job left `running` by an ended process is dealt with at the next launch.
  func claimTranscription() throws -> ClaimedJob? {
    guard
      let row = try db.all(
        """
        UPDATE job SET status = 'running', attempts = attempts + 1, updated_at = ?
        WHERE id = (SELECT id FROM job WHERE kind = ? AND status = 'queued' AND run_after <= ? ORDER BY priority DESC, created_at ASC LIMIT 1)
        RETURNING id, key, attempts
        """, [now(), Self.transcribeKind, now()]
      ).first,
      let id = row.string("id"), let key = row.string("key")
    else { return nil }
    return ClaimedJob(id: id, assetId: String(key.dropFirst(Self.transcribeKind.count + 1)), attempts: row.int("attempts") ?? 0)
  }

  /// Whether the claim still holds: the row is `running` with the claim's attempt count.
  func holds(_ job: ClaimedJob) throws -> Bool {
    try db.get("SELECT 1 AS v FROM job WHERE id = ? AND status = 'running' AND attempts = ?", [job.id, job.attempts]) != nil
  }

  func completeJob(_ job: ClaimedJob) throws {
    try db.run(
      "UPDATE job SET status = 'done', locked_until = NULL, last_error = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND attempts = ?",
      [now(), job.id, job.attempts])
  }

  /// A job that went wrong is `failed` at once, where the server retries it with backoff: on the phone the listener
  /// sees "Try again" and decides, rather than the file being fetched again behind their back.
  func failJob(_ job: ClaimedJob, _ error: String) throws {
    try db.run(
      "UPDATE job SET status = 'failed', locked_until = NULL, last_error = ?, updated_at = ? WHERE id = ? AND status = 'running' AND attempts = ?",
      [String(error.prefix(2000)), now(), job.id, job.attempts])
  }

  /// At launch, a job still `running` belongs to a process that has ended (iOS ends a suspended app whenever it
  /// likes), unless this process is running it (`runningHere`: the app made a second backend on the same folder).
  /// It is queued again to resume, as the server's expired lease is claimed again; one that has been interrupted
  /// `maxAttempts` times is failed instead. A download cut short starts over; a finished one is kept.
  static func recoverInterruptedJobs(_ db: Connection, nowMs now: Int, runningHere: Set<String>) throws {
    for row in try db.all("SELECT id, attempts FROM job WHERE status = 'running'") {
      guard let id = row.string("id"), !runningHere.contains(id) else { continue }
      if (row.int("attempts") ?? 0) >= maxAttempts {
        try db.run(
          "UPDATE job SET status = 'failed', locked_until = NULL, last_error = 'interrupted too many times', updated_at = ? WHERE id = ?", [now, id])
      } else {
        try db.run(
          "UPDATE job SET status = 'queued', locked_until = NULL, last_error = 'interrupted', run_after = ?, updated_at = ? WHERE id = ?", [now, now, id])
      }
    }
  }

  func hasRunnableJobs() throws -> Bool {
    try db.get("SELECT 1 AS v FROM job WHERE status = 'queued' LIMIT 1") != nil
  }

  /// `jobState` (server/src/services/episodes.ts): `ready` when the thing exists, else the job's status, `none`
  /// without one.
  func jobState(key: String, readyWhen: Bool) throws -> String {
    if readyWhen { return "ready" }
    guard let status = try db.get("SELECT status FROM job WHERE key = ?", [key])?.string("status") else { return "none" }
    return status == "done" ? "ready" : status
  }
}

/// The jobs of one process. The app can make a second `LocalBackend` on the same folder (leaving the phone's
/// library for a server and coming back) while the first still runs a job; both then share one runner, so it stays
/// one job at a time, and the second does not take the first's running job for an interrupted one.
final class JobHost: Sendable {
  static let shared = JobHost()

  private struct State {
    var runners: [String: JobRunner] = [:]
    var running: Set<String> = []
  }

  private let state = Mutex(State())

  init() {}

  func runner(for folder: URL) -> JobRunner {
    let key = folder.standardizedFileURL.path(percentEncoded: false)
    return state.withLock { state in
      if let runner = state.runners[key] { return runner }
      let runner = JobRunner()
      state.runners[key] = runner
      return runner
    }
  }

  var running: Set<String> { state.withLock { $0.running } }
  func begin(_ jobId: String) { state.withLock { _ = $0.running.insert(jobId) } }
  func end(_ jobId: String) { state.withLock { _ = $0.running.remove(jobId) } }
}

/// Runs queued jobs one at a time in a background task. `kick` starts it when idle; a kick while it works makes it
/// look again once the queue seems empty, so a job enqueued in that moment is not left waiting.
actor JobRunner {
  private var task: Task<Void, Never>?
  private var again = false

  func kick(_ drain: @escaping @Sendable () async -> Void) {
    again = true
    guard task == nil else { return }
    task = Task(priority: .utility) {
      while self.next() { await drain() }
    }
  }

  private func next() -> Bool {
    if again {
      again = false
      return true
    }
    task = nil
    return false
  }

  /// Wait until nothing is running (tests).
  func idle() async {
    while let task { await task.value }
  }
}
