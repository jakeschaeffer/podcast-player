import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalize } from "../src/core/transcript/normalize.js";
import type { RawWord } from "../src/core/transcript/types.js";
import { newId } from "../src/lib/ids.js";
import { fetchFeedChapters } from "../src/services/chapters.js";
import { getEpisode } from "../src/services/episodes.js";
import { refreshFeed } from "../src/services/feeds.js";
import { storeTranscript } from "../src/services/transcripts.js";
import { makeTone, recordingFixture } from "./helpers/fixture.js";

/** One word every 400 ms across the two-minute fixture, a sentence every 25 words, so the transcript has several segments. */
const words: RawWord[] = Array.from({ length: 290 }, (_, i) => ({ text: `w${i}${i % 25 === 24 ? "." : ""}`, start_ms: i * 400 + Math.floor(i / 25) * 10, end_ms: i * 400 + 300 + Math.floor(i / 25) * 10 }));
const transcript = normalize({ provider: "test", model: "test", language: "en", words, events: [] });
/** The index of the first word starting at or after `ms`, the long way round. */
const wordAt = (ms: number) => words.findIndex((w) => w.start_ms >= ms);

const SHOW_NOTES = `<p>We talk about pricing.</p><p>Timestamps</p><ul><li>(00:05) Introduction</li><li>(00:41) Pricing, take one</li><li>(01:20) Sponsor: Acme</li><li>(01:30) Usage pricing</li></ul><p>Links and credits.</p>`;
const AI_CHAPTERS = [
  { start_ms: 0, end_ms: 60_000, start_word: 0, end_word: 150, title: "Model chapter one", description: "From the summary.", kind: "content" },
  { start_ms: 60_000, end_ms: 120_000, start_word: 150, end_word: 290, title: "Model chapter two", description: "From the summary.", kind: "content" },
];

let mp3: string;
let server: Server;
let base: string;
let feedXml = "";
beforeAll(async () => {
  mp3 = await makeTone();
  server = createServer((req, res) => {
    if (req.url === "/chapters.json") {
      res.writeHead(200, { "content-type": "application/json+chapters" });
      res.end(JSON.stringify({ version: "1.2.0", chapters: [{ startTime: 0, title: "Cold open" }, { startTime: 30.2, title: "From the feed" }, { startTime: 61, title: "Also from the feed" }] }));
    } else if (req.url === "/feed.xml") {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end(feedXml);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

function fixture() {
  const f = recordingFixture(mp3);
  storeTranscript(f.ctx, f.assetId, transcript, {});
  const summaryId = newId();
  const transcriptId = f.ctx.db.prepare("SELECT transcript_id FROM audio_asset WHERE id = ?").pluck().get(f.assetId) as string;
  f.ctx.db
    .prepare("INSERT INTO episode_summary (id, transcript_id, model, prompt_version, preview, takeaways, chapters, created_at) VALUES (?, ?, 'm', 'v1', 'p', '[]', ?, 0)")
    .run(summaryId, transcriptId, JSON.stringify(AI_CHAPTERS));
  f.ctx.db.prepare("UPDATE audio_asset SET summary_id = ? WHERE id = ?").run(summaryId, f.assetId);
  return { ...f, transcriptId };
}

describe("episode chapters: the publisher's before the model's", () => {
  it("serves the model's chapters when the publisher gave none", () => {
    const { ctx, episodeId } = fixture();
    expect(getEpisode(ctx, episodeId, "none").chapters).toMatchObject({ source: "ai", items: [{ title: "Model chapter one" }, { title: "Model chapter two" }] });
  });

  it("serves show-notes timestamps over the model's chapters, each starting on its first transcript word", () => {
    const { ctx, episodeId, transcriptId } = fixture();
    ctx.db.prepare("UPDATE episode SET description_html = ? WHERE id = ?").run(SHOW_NOTES, episodeId);
    const chapters = getEpisode(ctx, episodeId, "none").chapters!;
    expect(chapters.source).toBe("shownotes");
    expect(chapters.transcript_id).toBe(transcriptId);
    expect(chapters.items).toEqual([
      { start_ms: 0, end_ms: 41_000, start_word: 0, end_word: wordAt(41_000), title: "Introduction", description: null, kind: "intro" },
      { start_ms: 41_000, end_ms: 80_000, start_word: wordAt(41_000), end_word: wordAt(80_000), title: "Pricing, take one", description: null, kind: "content" },
      { start_ms: 80_000, end_ms: 90_000, start_word: wordAt(80_000), end_word: wordAt(90_000), title: "Sponsor: Acme", description: null, kind: "ad" },
      { start_ms: 90_000, end_ms: 120_000, start_word: wordAt(90_000), end_word: 290, title: "Usage pricing", description: null, kind: "content" },
    ]);
    // 41 s falls mid-word in a later segment, so the chapter starts on the next word.
    expect(transcript.segments.length).toBeGreaterThan(3);
    expect(words[wordAt(41_000) - 1]!.end_ms).toBeGreaterThan(41_000);
  });

  it("leaves word indices null before there is a transcript, timing the chapters on the feed's duration", () => {
    const { ctx, episodeId } = recordingFixture(mp3);
    ctx.db.prepare("UPDATE episode SET description_html = ?, duration_hint_ms = 125000, current_asset_id = NULL WHERE id = ?").run(SHOW_NOTES, episodeId);
    const chapters = getEpisode(ctx, episodeId, "none").chapters!;
    expect(chapters).toMatchObject({ source: "shownotes", transcript_id: null });
    expect(chapters.items.map((c) => [c.start_ms, c.end_ms, c.start_word, c.end_word])).toEqual([[0, 41_000, null, null], [41_000, 80_000, null, null], [80_000, 90_000, null, null], [90_000, 125_000, null, null]]);
  });

  it("takes the feed's JSON chapters on refresh, fetched once, over the show notes", async () => {
    const { ctx, episodeId } = fixture();
    const feedId = ctx.db.prepare("SELECT feed_id FROM episode WHERE id = ?").pluck().get(episodeId) as string;
    ctx.db.prepare("UPDATE feed SET url_enc = ? WHERE id = ?").run(ctx.secrets.encrypt(`${base}/feed.xml`), feedId);
    ctx.db.prepare("UPDATE episode SET description_html = ? WHERE id = ?").run(SHOW_NOTES, episodeId);
    feedXml = `<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>Fixture Show</title>
      <item><title>Pricing</title><guid>g1</guid><enclosure url="${base}/a.mp3" type="audio/mpeg"/><podcast:chapters url="${base}/chapters.json" type="application/json+chapters"/></item>
    </channel></rss>`;
    await refreshFeed(ctx, feedId);
    expect(JSON.parse(ctx.db.prepare("SELECT feed_chapters FROM episode WHERE id = ?").pluck().get(episodeId) as string)).toHaveLength(3);
    const chapters = getEpisode(ctx, episodeId, "none").chapters!;
    expect(chapters.source).toBe("feed");
    expect(chapters.items.map((c) => [c.start_ms, c.start_word, c.title])).toEqual([[0, 0, "Cold open"], [30_200, wordAt(30_200), "From the feed"], [61_000, wordAt(61_000), "Also from the feed"]]);
  });

  it("records a chapters file that is not there, so it is not fetched again, and falls back to the show notes", async () => {
    const { ctx, episodeId } = fixture();
    ctx.db.prepare("UPDATE episode SET description_html = ?, chapters_url_enc = ? WHERE id = ?").run(SHOW_NOTES, ctx.secrets.encrypt(`${base}/missing.json`), episodeId);
    await fetchFeedChapters(ctx, episodeId);
    expect(ctx.db.prepare("SELECT feed_chapters FROM episode WHERE id = ?").pluck().get(episodeId)).toBe("[]");
    expect(getEpisode(ctx, episodeId, "none").chapters!.source).toBe("shownotes");
  });

  it("keeps aligned publisher text sections first", () => {
    const { ctx, episodeId, assetId } = fixture();
    ctx.db.prepare("UPDATE episode SET description_html = ? WHERE id = ?").run(SHOW_NOTES, episodeId);
    const textId = newId();
    ctx.db
      .prepare("INSERT INTO episode_text (id, episode_id, source, source_ref, title, kind, text, paragraphs, sections, word_count, created_at) VALUES (?, ?, 'rss', ?, 'Pricing', 'update', '', '[]', ?, 290, 0)")
      .run(textId, episodeId, textId, JSON.stringify([{ title: "Section one", start_ms: 0, start_word: 0 }, { title: "Section two", start_ms: 50_000, start_word: 125 }]));
    storeTranscript(ctx, assetId, transcript, { source: "rss", text_id: textId, make_current: false });
    expect(getEpisode(ctx, episodeId, "none").chapters).toMatchObject({ source: "publisher", items: [{ title: "Section one" }, { title: "Section two" }] });
  });
});
