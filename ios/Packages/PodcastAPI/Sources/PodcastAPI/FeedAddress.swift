import Foundation

/// Whether text typed into the show search is a feed address rather than a name, ported from the web's
/// `asFeedUrl` (web/src/lib/feedUrl.ts). Private feeds (a paid show, a premium tier) are not in any directory, so the
/// only way to add one is to paste its URL; the search screen then offers to subscribe to that address directly.
public enum FeedAddress {
  /// The URL to send to `POST /v1/feeds`, or nil for an ordinary search. A bare domain ("acquired.fm") is more
  /// likely a show's name or site than its feed, so only an http(s) URL or a host with a path counts.
  public static func parse(_ text: String) -> String? {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.isEmpty || t.contains(where: \.isWhitespace) { return nil }
    let withScheme: String
    if t.range(of: #"^https?://"#, options: [.regularExpression, .caseInsensitive]) != nil {
      withScheme = t
    } else if t.range(
      of: #"^(www\.|feeds?\.)|^[a-z0-9-]+(\.[a-z0-9-]+)+/\S"#, options: [.regularExpression, .caseInsensitive])
      != nil
    {
      withScheme = "https://\(t)"
    } else {
      return nil
    }
    guard let url = URLComponents(string: withScheme), let host = url.host, host.contains(".") else { return nil }
    return withScheme
  }
}
