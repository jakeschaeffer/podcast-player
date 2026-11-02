import Foundation

/// A YouTube link pasted into the show search: a video (any of the URL forms the web uses) or a channel (by id,
/// handle, or custom name; a bare `@handle` counts). Ported from the server's `youtubeIdFrom` and
/// `youtubeChannelPage` (server/src/core/feed/youtube.ts), so the app offers the right action before the server
/// sees the link.
public enum YouTubeLink: Equatable, Sendable {
  /// A video, as the URL to send to `POST /v1/youtube/episodes`.
  case video(id: String, url: String)
  /// A channel page, as the URL to send to `POST /v1/feeds`.
  case channel(url: String)

  public static func parse(_ text: String) -> YouTubeLink? {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.isEmpty || t.contains(where: \.isWhitespace) { return nil }
    if t.range(of: #"^@[A-Za-z0-9._-]{3,}$"#, options: .regularExpression) != nil {
      return .channel(url: "https://www.youtube.com/\(t)")
    }
    let withScheme = t.range(of: #"^https?://"#, options: [.regularExpression, .caseInsensitive]) == nil ? "https://\(t)" : t
    guard let url = URL(string: withScheme), let rawHost = url.host()?.lowercased() else { return nil }
    let host = rawHost.replacingOccurrences(of: #"^(www|m|music)\."#, with: "", options: .regularExpression)
    let path = url.path()
    if host == "youtu.be" {
      return videoID(path.split(separator: "/").first.map(String.init))
    }
    guard host == "youtube.com" || host == "youtube-nocookie.com" else { return nil }
    if path == "/watch" {
      return videoID(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "v" }?.value)
    }
    if let m = path.firstMatch(of: #/^/(?:embed|shorts|live|v)/([^/?]+)/#) {
      return videoID(String(m.1))
    }
    if let m = path.firstMatch(of: #/^/(channel/UC[A-Za-z0-9_-]{22}|@[^/?]+|c/[^/?]+|user/[^/?]+)/#) {
      return .channel(url: "https://www.youtube.com/\(m.1)")
    }
    return nil
  }

  private static func videoID(_ id: String?) -> YouTubeLink? {
    guard let id, id.range(of: #"^[A-Za-z0-9_-]{11}$"#, options: .regularExpression) != nil else { return nil }
    return .video(id: id, url: "https://www.youtube.com/watch?v=\(id)")
  }
}
