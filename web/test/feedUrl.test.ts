import { describe, expect, it } from "vitest";
import { asFeedUrl } from "../src/lib/feedUrl";

describe("asFeedUrl", () => {
  it("treats addresses as feeds and names as searches", () => {
    expect(asFeedUrl("https://feeds.megaphone.fm/hardfork")).toBe("https://feeds.megaphone.fm/hardfork");
    expect(asFeedUrl("  http://example.com/rss?token=abc ")).toBe("http://example.com/rss?token=abc");
    expect(asFeedUrl("feeds.simplecast.com/abc123")).toBe("https://feeds.simplecast.com/abc123");
    expect(asFeedUrl("www.example.com/podcast.xml")).toBe("https://www.example.com/podcast.xml");
    expect(asFeedUrl("example.com/feed")).toBe("https://example.com/feed");
    expect(asFeedUrl("hard fork")).toBeNull();
    expect(asFeedUrl("stratechery")).toBeNull();
    expect(asFeedUrl("acquired.fm")).toBeNull(); // a bare domain is more likely a show's name or site than its feed
    expect(asFeedUrl("ftp://example.com/feed")).toBeNull();
    expect(asFeedUrl("https://localhost/feed")).toBeNull();
    expect(asFeedUrl("")).toBeNull();
  });
});
