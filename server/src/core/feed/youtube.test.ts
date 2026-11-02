import { describe, expect, it } from "vitest";
import { channelIdInPage, isoDurationMs, parseWatchPage, parseYouTubeFeed, youtubeChannelPage, youtubeIdFrom, youtubeIdIn } from "./youtube.js";

describe("youtubeIdFrom", () => {
  it("reads every common URL form", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=bJD1NpdMY5s",
      "https://youtube.com/watch?feature=share&v=bJD1NpdMY5s",
      "https://youtu.be/bJD1NpdMY5s",
      "https://youtu.be/bJD1NpdMY5s?t=120",
      "https://www.youtube.com/embed/bJD1NpdMY5s",
      "https://www.youtube.com/shorts/bJD1NpdMY5s",
      "https://m.youtube.com/watch?v=bJD1NpdMY5s",
    ]) expect(youtubeIdFrom(url), url).toBe("bJD1NpdMY5s");
  });

  it("ignores other YouTube pages and other sites", () => {
    expect(youtubeIdFrom("https://www.youtube.com/@DwarkeshPatel")).toBeNull();
    expect(youtubeIdFrom("https://www.youtube.com/playlist?list=PLd7")).toBeNull();
    expect(youtubeIdFrom("https://vimeo.com/123")).toBeNull();
    expect(youtubeIdFrom("not a url")).toBeNull();
  });
});

describe("youtubeIdIn", () => {
  it("finds the one video the show notes link, however it is punctuated", () => {
    expect(youtubeIdIn('<p>Watch on <a href="https://youtu.be/7lSOI21E68g">YouTube</a>.</p>')).toBe("7lSOI21E68g");
    expect(youtubeIdIn("Video: https://www.youtube.com/watch?v=7lSOI21E68g.")).toBe("7lSOI21E68g");
    expect(youtubeIdIn("Same video twice: https://youtu.be/7lSOI21E68g and https://www.youtube.com/watch?v=7lSOI21E68g")).toBe("7lSOI21E68g");
  });

  it("gives up when the notes link several videos, or none", () => {
    expect(youtubeIdIn("https://youtu.be/7lSOI21E68g and https://youtu.be/frYSOKvNiiE")).toBeNull();
    expect(youtubeIdIn("Our channel: https://www.youtube.com/@DwarkeshPatel")).toBeNull();
    expect(youtubeIdIn(null)).toBeNull();
  });
});

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=UCXl4i9dYBrFOabk0xGmbkRA"/>
 <id>yt:channel:Xl4i9dYBrFOabk0xGmbkRA</id>
 <yt:channelId>UCXl4i9dYBrFOabk0xGmbkRA</yt:channelId>
 <title>Dwarkesh Patel</title>
 <link rel="alternate" href="https://www.youtube.com/channel/UCXl4i9dYBrFOabk0xGmbkRA"/>
 <author><name>Dwarkesh Patel</name><uri>https://www.youtube.com/channel/UCXl4i9dYBrFOabk0xGmbkRA</uri></author>
 <published>2019-11-29T17:50:03+00:00</published>
 <entry>
  <id>yt:video:bJD1NpdMY5s</id>
  <yt:videoId>bJD1NpdMY5s</yt:videoId>
  <yt:channelId>UCXl4i9dYBrFOabk0xGmbkRA</yt:channelId>
  <title>What will automated firms look like?</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=bJD1NpdMY5s"/>
  <author><name>Dwarkesh Patel</name><uri>https://www.youtube.com/channel/UCXl4i9dYBrFOabk0xGmbkRA</uri></author>
  <published>2026-04-30T15:00:12+00:00</published>
  <updated>2026-05-01T09:12:44+00:00</updated>
  <media:group>
   <media:title>What will automated firms look like?</media:title>
   <media:content url="https://www.youtube.com/v/bJD1NpdMY5s?version=3" type="application/x-shockwave-flash" width="640" height="390"/>
   <media:thumbnail url="https://i2.ytimg.com/vi/bJD1NpdMY5s/hqdefault.jpg" width="480" height="360"/>
   <media:description>A video recording of an essay.
Read it here: https://www.dwarkesh.com/p/automated-firms</media:description>
  </media:group>
 </entry>
 <entry>
  <id>yt:video:bad</id>
  <yt:videoId>bad</yt:videoId>
  <title>Not a video id</title>
 </entry>
</feed>`;

describe("parseYouTubeFeed", () => {
  const parsed = parseYouTubeFeed(FEED);

  it("reads the channel", () => {
    expect(parsed.channel).toEqual({ channel_id: "UCXl4i9dYBrFOabk0xGmbkRA", title: "Dwarkesh Patel", author: "Dwarkesh Patel", site_url: "https://www.youtube.com/channel/UCXl4i9dYBrFOabk0xGmbkRA" });
  });

  it("reads each video and skips malformed entries", () => {
    expect(parsed.videos).toEqual([
      {
        video_id: "bJD1NpdMY5s",
        title: "What will automated firms look like?",
        description: "A video recording of an essay.\nRead it here: https://www.dwarkesh.com/p/automated-firms",
        published_at: Date.parse("2026-04-30T15:00:12+00:00"),
        thumbnail_url: "https://i2.ytimg.com/vi/bJD1NpdMY5s/hqdefault.jpg",
        link: "https://www.youtube.com/watch?v=bJD1NpdMY5s",
      },
    ]);
  });

  it("refuses a podcast feed", () => {
    expect(() => parseYouTubeFeed("<rss><channel><title>x</title></channel></rss>")).toThrow(/not a YouTube channel feed/);
  });
});

describe("channel pages", () => {
  it("knows which URLs name a channel", () => {
    expect(youtubeChannelPage("https://www.youtube.com/@DwarkeshPatel")).toBe("https://www.youtube.com/@DwarkeshPatel");
    expect(youtubeChannelPage("https://youtube.com/@DwarkeshPatel/videos")).toBe("https://www.youtube.com/@DwarkeshPatel");
    expect(youtubeChannelPage("https://www.youtube.com/channel/UCXl4i9dYBrFOabk0xGmbkRA")).toBe("https://www.youtube.com/channel/UCXl4i9dYBrFOabk0xGmbkRA");
    expect(youtubeChannelPage("https://www.youtube.com/watch?v=bJD1NpdMY5s")).toBeNull();
    expect(youtubeChannelPage("https://example.com/@x")).toBeNull();
  });

  it("finds the channel id in a channel page", () => {
    // Another channel's id comes first on a real page (a channel it shows); the page's own is its externalId or canonical link.
    expect(channelIdInPage('<script>{"channelId":"UCZa18YV7qayTh-MRIrBhDpA"} var ytInitialData = {"metadata":{"channelMetadataRenderer":{"externalId":"UCXl4i9dYBrFOabk0xGmbkRA"}}}</script>')).toBe("UCXl4i9dYBrFOabk0xGmbkRA");
    expect(channelIdInPage('{"channelId":"UCZa18YV7qayTh-MRIrBhDpA"}<link rel="canonical" href="https://www.youtube.com/channel/UCXl4i9dYBrFOabk0xGmbkRA">')).toBe("UCXl4i9dYBrFOabk0xGmbkRA");
    expect(channelIdInPage('<link rel="canonical" href="https://www.youtube.com/channel/UCXl4i9dYBrFOabk0xGmbkRA">')).toBe("UCXl4i9dYBrFOabk0xGmbkRA");
    expect(channelIdInPage("<html>nothing</html>")).toBeNull();
  });
});

describe("parseWatchPage", () => {
  const page = `<html><head>
<meta property="og:title" content="What Robert Caro learned about power &amp; its uses">
<meta property="og:description" content="Links: https://example.com">
<meta property="og:image" content="https://i.ytimg.com/vi/f0J_EeW42Lo/maxresdefault.jpg">
<link itemprop="thumbnailUrl" href="https://i.ytimg.com/vi/f0J_EeW42Lo/maxresdefault.jpg">
<meta itemprop="datePublished" content="2026-10-30T10:18:35-07:00">
<meta itemprop="duration" content="PT61M10S">
<meta itemprop="channelId" content="UCXl4i9dYBrFOabk0xGmbkRA">
</head><body><script>var x = {"channelId":"UCrecommendedXXXXXXXXXXXX","externalChannelId":"UCXl4i9dYBrFOabk0xGmbkRA","ownerChannelName":"Dwarkesh Patel"};</script></body></html>`;

  it("reads the owner's channel, the title, the length and the date", () => {
    expect(parseWatchPage(page, "f0J_EeW42Lo")).toEqual({
      video_id: "f0J_EeW42Lo",
      channel_id: "UCXl4i9dYBrFOabk0xGmbkRA",
      channel_name: "Dwarkesh Patel",
      title: "What Robert Caro learned about power & its uses",
      description: "Links: https://example.com",
      published_at: Date.parse("2026-10-30T10:18:35-07:00"),
      duration_ms: 3670_000,
      thumbnail_url: "https://i.ytimg.com/vi/f0J_EeW42Lo/maxresdefault.jpg",
      link: "https://www.youtube.com/watch?v=f0J_EeW42Lo",
    });
  });

  it("falls back to the player response's length, and gives up without an owner", () => {
    const noMeta = page.replace(/<meta itemprop="duration"[^>]*>/, "").replace("</script>", "</script><script>{\"lengthSeconds\":\"3670\"}</script>");
    expect(parseWatchPage(noMeta, "f0J_EeW42Lo")?.duration_ms).toBe(3670_000);
    expect(parseWatchPage("<html><meta property=\"og:title\" content=\"x\"></html>", "f0J_EeW42Lo")).toBeNull();
  });

  it("reads ISO durations", () => {
    expect(isoDurationMs("PT1H2M3S")).toBe(3723_000);
    expect(isoDurationMs("PT45S")).toBe(45_000);
    expect(isoDurationMs("PT")).toBeNull();
    expect(isoDurationMs(null)).toBeNull();
  });
});
