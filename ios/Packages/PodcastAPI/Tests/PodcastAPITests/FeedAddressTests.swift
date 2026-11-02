import Testing

@testable import PodcastAPI

/// The same cases as web/test/feedUrl.test.ts, so the app and the web agree on what counts as a feed address.
struct FeedAddressTests {
  @Test func addressesAreFeedsAndNamesAreSearches() {
    #expect(FeedAddress.parse("https://feeds.megaphone.fm/hardfork") == "https://feeds.megaphone.fm/hardfork")
    #expect(FeedAddress.parse("  http://example.com/rss?token=abc ") == "http://example.com/rss?token=abc")
    #expect(FeedAddress.parse("feeds.simplecast.com/abc123") == "https://feeds.simplecast.com/abc123")
    #expect(FeedAddress.parse("www.example.com/podcast.xml") == "https://www.example.com/podcast.xml")
    #expect(FeedAddress.parse("example.com/feed") == "https://example.com/feed")
    #expect(FeedAddress.parse("hard fork") == nil)
    #expect(FeedAddress.parse("stratechery") == nil)
    #expect(FeedAddress.parse("acquired.fm") == nil)
    #expect(FeedAddress.parse("ftp://example.com/feed") == nil)
    #expect(FeedAddress.parse("https://localhost/feed") == nil)
    #expect(FeedAddress.parse("") == nil)
  }
}
