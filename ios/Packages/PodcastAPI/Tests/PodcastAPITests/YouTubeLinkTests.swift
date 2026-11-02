import Testing

@testable import PodcastAPI

struct YouTubeLinkTests {
  @Test func videoLinksInEveryForm() {
    for text in [
      "https://www.youtube.com/watch?v=bJD1NpdMY5s",
      "youtube.com/watch?feature=share&v=bJD1NpdMY5s",
      "https://youtu.be/bJD1NpdMY5s?t=120",
      "https://www.youtube.com/shorts/bJD1NpdMY5s",
      "https://m.youtube.com/live/bJD1NpdMY5s",
    ] {
      #expect(YouTubeLink.parse(text) == .video(id: "bJD1NpdMY5s", url: "https://www.youtube.com/watch?v=bJD1NpdMY5s"), "\(text)")
    }
  }

  @Test func channelLinksAndHandles() {
    #expect(YouTubeLink.parse("https://www.youtube.com/@DwarkeshPatel") == .channel(url: "https://www.youtube.com/@DwarkeshPatel"))
    #expect(YouTubeLink.parse("@DwarkeshPatel") == .channel(url: "https://www.youtube.com/@DwarkeshPatel"))
    #expect(YouTubeLink.parse("youtube.com/channel/UCXl4i9dYBrFOabk0xGmbkRA/videos") == .channel(url: "https://www.youtube.com/channel/UCXl4i9dYBrFOabk0xGmbkRA"))
    #expect(YouTubeLink.parse("https://www.youtube.com/c/LatentSpace") == .channel(url: "https://www.youtube.com/c/LatentSpace"))
  }

  @Test func otherTextIsNotALink() {
    for text in ["acquired", "https://example.com/watch?v=bJD1NpdMY5s", "https://www.youtube.com/playlist?list=PL123", "https://youtu.be/short", "@ab"] {
      #expect(YouTubeLink.parse(text) == nil, "\(text)")
    }
  }
}
