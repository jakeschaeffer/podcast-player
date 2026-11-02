import { describe, expect, it } from "vitest";
import { classifyLink } from "../src/lib/links";

/** The same cases as the native app's YouTubeLinkTests and MediaLinkTests, so both clients offer the same action. */
describe("classifyLink", () => {
  it("knows YouTube videos in every form", () => {
    for (const text of [
      "https://www.youtube.com/watch?v=bJD1NpdMY5s",
      "youtube.com/watch?feature=share&v=bJD1NpdMY5s",
      "https://youtu.be/bJD1NpdMY5s?t=120",
      "https://www.youtube.com/shorts/bJD1NpdMY5s",
      "https://m.youtube.com/live/bJD1NpdMY5s",
    ]) {
      expect(classifyLink(text), text).toEqual({ kind: "youtube-video", url: "https://www.youtube.com/watch?v=bJD1NpdMY5s" });
    }
  });

  it("knows channels and handles", () => {
    expect(classifyLink("https://www.youtube.com/@DwarkeshPatel")).toEqual({ kind: "youtube-channel", url: "https://www.youtube.com/@DwarkeshPatel" });
    expect(classifyLink("@DwarkeshPatel")).toEqual({ kind: "youtube-channel", url: "https://www.youtube.com/@DwarkeshPatel" });
    expect(classifyLink("youtube.com/channel/UCXl4i9dYBrFOabk0xGmbkRA/videos")).toEqual({ kind: "youtube-channel", url: "https://www.youtube.com/channel/UCXl4i9dYBrFOabk0xGmbkRA" });
  });

  it("tells media files from feed addresses by their extension", () => {
    expect(classifyLink("https://video.twimg.com/amplify_video/2117182449197404160/vid/avc1/3840x2160/jEEwY1sNJVlzBYOx.mp4?tag=29")).toEqual({
      kind: "media",
      url: "https://video.twimg.com/amplify_video/2117182449197404160/vid/avc1/3840x2160/jEEwY1sNJVlzBYOx.mp4?tag=29",
    });
    expect(classifyLink("cdn.example.com/talks/keynote.m4a")).toEqual({ kind: "media", url: "https://cdn.example.com/talks/keynote.m4a" });
    expect(classifyLink("https://feeds.megaphone.fm/hardfork")).toEqual({ kind: "feed", url: "https://feeds.megaphone.fm/hardfork" });
    expect(classifyLink("https://x.com/someone/status/2117182449197404160")).toEqual({ kind: "feed", url: "https://x.com/someone/status/2117182449197404160" });
  });

  it("leaves names and junk to the search", () => {
    for (const text of ["acquired", "hard fork", "https://www.youtube.com/playlist?list=PL123", "https://youtu.be/short", "@ab", ""]) {
      expect(classifyLink(text), text).toBeNull();
    }
  });
});
