import Testing

@testable import PodcastAPI

/// The same cases as web/test/links.test.ts, so the app and the web offer the same action for a pasted file link.
struct MediaLinkTests {
  @Test func fileLinksByExtension() {
    let x = "https://video.twimg.com/amplify_video/2117182449197404160/vid/avc1/3840x2160/jEEwY1sNJVlzBYOx.mp4?tag=29"
    #expect(MediaLink.parse(x) == x)
    #expect(MediaLink.parse("cdn.example.com/talks/keynote.m4a") == "https://cdn.example.com/talks/keynote.m4a")
    #expect(MediaLink.parse(" https://example.com/a/b/Talk.MP3 ") == "https://example.com/a/b/Talk.MP3")
  }

  @Test func feedsPagesAndNamesAreNotFiles() {
    for text in [
      "https://feeds.megaphone.fm/hardfork", "https://x.com/someone/status/2117182449197404160", "acquired", "hard fork", "",
      "https://www.youtube.com/watch?v=bJD1NpdMY5s",
    ] {
      #expect(MediaLink.parse(text) == nil, "\(text)")
    }
  }
}
