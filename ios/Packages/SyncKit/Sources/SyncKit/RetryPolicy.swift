import PodcastAPI

/// What an outbox does with a failed request. Mirrors web/src/snips/outbox.ts and web/src/player/reporter.ts:
/// a 4xx other than 401 will never succeed, so it is dropped; 401 (signed out), 5xx and offline are kept.
public enum RetryPolicy {
  public enum Outcome: Equatable, Sendable { case delivered, drop, keep }

  public static func outcome(for error: Error?) -> Outcome {
    guard let error else { return .delivered }
    guard let api = error as? APIError else { return .keep }
    if api.isNetwork || api.status == 401 || api.status >= 500 { return .keep }
    return (400..<500).contains(api.status) ? .drop : .keep
  }
}
