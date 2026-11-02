import { describe, expect, it } from "vitest";
import { duration, parseFeed } from "./parse.js";

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>Test Show</title>
  <link>https://example.com/show</link>
  <language>en-us</language>
  <itunes:author>Example Studio</itunes:author>
  <itunes:image href="https://example.com/art.jpg"/>
  <item>
    <title>Episode Two</title>
    <guid isPermaLink="false">ep-2</guid>
    <pubDate>Tue, 20 Oct 2026 10:00:00 GMT</pubDate>
    <itunes:duration>1:02:03</itunes:duration>
    <description><![CDATA[<p>Notes with <script>alert(1)</script><a href="https://x.test">link</a></p>]]></description>
    <enclosure url="https://cdn.example.com/ep2.mp3?token=abc" type="audio/mpeg" length="12345"/>
  </item>
  <item>
    <title>No GUID</title>
    <link>https://example.com/ep1</link>
    <enclosure url="https://cdn.example.com/ep1.mp3?sig=1" type="audio/mpeg"/>
  </item>
  <item>
    <title>No enclosure</title>
    <guid>ep-0</guid>
  </item>
  <item>
    <title>Video first, audio second</title>
    <guid>ep-3</guid>
    <enclosure url="https://cdn.example.com/ep3.mp4" type="video/mp4"/>
    <enclosure url="https://cdn.example.com/ep3.m4a" type="audio/x-m4a"/>
  </item>
</channel>
</rss>`;

describe("parseFeed", () => {
  const parsed = parseFeed(FEED);

  it("reads channel metadata", () => {
    expect(parsed.feed).toEqual({
      title: "Test Show",
      author: "Example Studio",
      image_url: "https://example.com/art.jpg",
      site_url: "https://example.com/show",
      language: "en-us",
    });
  });

  it("uses the guid when present and falls back to the enclosure URL without its query", () => {
    expect(parsed.items.map((i) => [i.identity, i.identity_source])).toEqual([
      ["ep-2", "guid"],
      ["https://cdn.example.com/ep1.mp3", "enclosure"],
      ["ep-3", "guid"],
    ]);
  });

  it("skips items without an enclosure and reports them", () => {
    expect(parsed.skipped).toEqual([{ title: "No enclosure", reason: "no enclosure" }]);
  });

  it("prefers the audio enclosure and remembers the video one", () => {
    expect(parsed.items[2]!.enclosure_url).toBe("https://cdn.example.com/ep3.m4a");
    expect(parsed.items[2]!.media_kind).toBe("audio");
    expect(parsed.items[2]!.video_url).toBe("https://cdn.example.com/ep3.mp4");
    expect(parsed.items[0]!.video_url).toBeNull();
  });

  it("parses dates, durations, sizes, and raw description html", () => {
    const ep = parsed.items[0]!;
    expect(ep.published_at).toBe(Date.parse("2026-10-20T10:00:00Z"));
    expect(ep.duration_hint_ms).toBe((1 * 3600 + 2 * 60 + 3) * 1000);
    expect(ep.enclosure_bytes).toBe(12345);
    expect(ep.description_html).toContain("<script>"); // sanitized later, at storage time
  });

  it("never throws on junk but refuses non-feeds", () => {
    expect(() => parseFeed("<html><body>hi</body></html>")).toThrow(/not an RSS feed/);
    expect(parseFeed("<rss><channel><title>x</title></channel></rss>").items).toEqual([]);
  });
});

describe("parseFeed: publisher chapters", () => {
  const CHAPTERED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:psc="http://podlove.org/simple-chapters">
<channel>
  <title>Chaptered</title>
  <item>
    <title>Podcasting 2.0</title>
    <guid>pc20</guid>
    <enclosure url="https://cdn.example.com/a.mp3" type="audio/mpeg"/>
    <podcast:chapters url="https://cdn.example.com/a.html" type="text/html"/>
    <podcast:chapters url="https://cdn.example.com/a.json?k=1" type="application/json+chapters"/>
  </item>
  <item>
    <title>Podlove</title>
    <guid>psc</guid>
    <enclosure url="https://cdn.example.com/b.mp3" type="audio/mpeg"/>
    <psc:chapters version="1.2">
      <psc:chapter start="00:00:00.000" title="Intro"/>
      <psc:chapter start="00:12:30.500" title="Main topic" href="https://example.com"/>
      <psc:chapter start="1:02:03" title="Listener mail"/>
      <psc:chapter start="bogus" title="Dropped"/>
    </psc:chapters>
  </item>
  <item>
    <title>One psc chapter</title>
    <guid>psc1</guid>
    <enclosure url="https://cdn.example.com/c.mp3" type="audio/mpeg"/>
    <psc:chapters><psc:chapter start="0" title="Everything"/></psc:chapters>
  </item>
</channel>
</rss>`;
  const items = parseFeed(CHAPTERED).items;

  it("keeps the JSON chapters URL and ignores other types", () => {
    expect(items[0]!.chapters_url).toBe("https://cdn.example.com/a.json?k=1");
    expect(items[0]!.chapters).toBeNull();
  });

  it("reads Podlove Simple Chapters inline, and needs two of them", () => {
    expect(items[1]!.chapters).toEqual([
      { start_ms: 0, title: "Intro" },
      { start_ms: 750_500, title: "Main topic" },
      { start_ms: 3_723_000, title: "Listener mail" },
    ]);
    expect(items[1]!.chapters_url).toBeNull();
    expect(items[2]!.chapters).toBeNull();
  });
});

describe("duration", () => {
  it("accepts HH:MM:SS, MM:SS and seconds", () => {
    expect(duration("1:02:03")).toBe(3723000);
    expect(duration("02:03")).toBe(123000);
    expect(duration("45")).toBe(45000);
    expect(duration("abc")).toBeNull();
    expect(duration("")).toBeNull();
  });
});
