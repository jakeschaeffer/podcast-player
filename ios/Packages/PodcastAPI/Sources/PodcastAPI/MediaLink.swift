import Foundation

/// A link to a video or audio file pasted into the show search (or shared into the app), told by its extension, for
/// `POST /v1/links/episodes`: the file becomes a one-off episode of the Pasted links show, downloaded and transcribed
/// by the server. Checked after `YouTubeLink` and before `FeedAddress`, as the web's `classifyLink` does; a media
/// link without an extension looks like a feed address here, and the search screen offers the one-off as a second
/// choice there. Ported from web/src/lib/links.ts.
public enum MediaLink {
  /// The URL to send, or nil when the text is not a link to a media file.
  public static func parse(_ text: String) -> String? {
    guard let url = FeedAddress.parse(text), let parsed = URL(string: url) else { return nil }
    let path = parsed.path().lowercased()
    guard path.range(of: #"\.(mp4|m4v|mov|webm|mkv|mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac|wma)$"#, options: .regularExpression) != nil else {
      return nil
    }
    return url
  }
}
