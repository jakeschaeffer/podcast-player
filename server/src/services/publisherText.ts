/**
 * Publisher text as a second source for an episode's words: a text feed's items (or, optionally, newsletter
 * emails) matched to episodes, extracted to `episode_text`, and aligned to the stored audio with forced
 * alignment so the publisher's own words carry timings. One alignment per recording is kept.
 */
import { QUOTE_LABEL } from "../core/speakers/identify.js";
import type { AppContext } from "../app/context.js";
import { parseTextFeed } from "../core/feed/parse.js";
import { normalize } from "../core/transcript/normalize.js";
import { normalizeToken } from "../core/transcript/tokens.js";
import type { RawWord } from "../core/transcript/types.js";
import type { AudioAssetRow, EpisodeRow, FeedRow } from "../db/rows.js";
import { DeferJob, NonRetryable } from "../jobs/errors.js";
import { PRIORITY, type Job } from "../jobs/queue.js";
import { extractArticle, type ArticleText } from "../lib/articleHtml.js";
import { newId } from "../lib/ids.js";
import { redact } from "../lib/safeFetch.js";
import { fetchFeedDocument, type RefreshReport } from "./feeds.js";
import { applyTextPolicyForAsset } from "./textPolicy.js";
import { findEpisodeByTitle } from "./titleMatch.js";
import { storeTranscript } from "./transcripts.js";

/** An article matches an episode published within this long of it; an unmatched item younger than this may still. */
const TEXT_MATCH_WINDOW_MS = 4 * 86_400_000;

export type EpisodeTextRow = {
  id: string; episode_id: string; source: string; source_ref: string; title: string; kind: string | null;
  text: string; paragraphs: string; sections: string; word_count: number; received_at: number | null; created_at: number;
};

export function getEpisodeText(ctx: AppContext, id: string): EpisodeTextRow | undefined {
  return ctx.db.prepare("SELECT * FROM episode_text WHERE id = ?").get(id) as EpisodeTextRow | undefined;
}

/** Insert an article for an episode and, when wanted and possible, queue its alignment. */
export function storeEpisodeText(
  ctx: AppContext,
  input: { episode: EpisodeRow; source: "rss" | "email"; source_ref: string; article: ArticleText; received_at: number | null; align: boolean; priority?: number },
): { id: string; align_enqueued: boolean } {
  const { episode, article } = input;
  const id = newId();
  ctx.db
    .prepare("INSERT INTO episode_text (id, episode_id, source, source_ref, title, kind, text, paragraphs, sections, word_count, received_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, episode.id, input.source, input.source_ref, article.title, article.kind, article.text, JSON.stringify(article.paragraphs), JSON.stringify(article.sections), article.word_count, input.received_at, ctx.now());
  let align_enqueued = false;
  if (input.align && episode.current_asset_id) {
    ctx.queue.enqueue("align_text", `align_text:${id}`, { text_id: id }, { priority: input.priority ?? PRIORITY.catalog });
    align_enqueued = true;
  }
  return { id, align_enqueued };
}

/**
 * A text feed's items are the show's articles. Each new item is matched to an episode of the companion podcast
 * feed by title and date, its body extracted into `episode_text`, and, when the episode has audio, queued for
 * forced alignment. Items that match no episode yet are retried on the next refresh (nothing is stored for them).
 *
 * Stratechery posts the article about an hour before the podcast item, so the newest item often has no episode at
 * first. While a recent item is unmatched the feed's validators are not kept, so the next refresh downloads the
 * feed again instead of getting a 304 that would skip the retry until the publisher next changes the feed. The
 * podcast feed's own refresh also re-reads its text feeds as soon as a new episode lands (`refreshFeed`).
 */
export async function refreshTextFeed(ctx: AppContext, feed: FeedRow): Promise<RefreshReport> {
  if (!feed.text_for_feed_id) throw new NonRetryable("text feed has no companion podcast feed");
  const empty: RefreshReport = { feed_id: feed.id, not_modified: false, new_episodes: 0, skipped: [], enqueued_audio: 0, texts: { new: 0, unmatched: [], align_enqueued: 0 } };
  const fetched = await fetchFeedDocument(ctx, feed, parseTextFeed);
  if (!fetched) return { ...empty, not_modified: true };
  const { doc: parsed } = fetched;
  ctx.db
    .prepare("UPDATE feed SET title = COALESCE(?, title), author = COALESCE(?, author), image_url = COALESCE(?, image_url), site_url = COALESCE(?, site_url), language = COALESCE(?, language), etag = ?, last_modified = ?, last_refresh_at = ?, last_error = NULL WHERE id = ?")
    .run(parsed.feed.title, parsed.feed.author, parsed.feed.image_url, parsed.feed.site_url, parsed.feed.language, fetched.etag, fetched.lastModified, ctx.now(), feed.id);

  const episodes = ctx.db.prepare("SELECT * FROM episode WHERE feed_id = ?").all(feed.text_for_feed_id) as EpisodeRow[];
  const exists = ctx.db.prepare("SELECT 1 FROM episode_text WHERE source = 'rss' AND source_ref = ?");
  const report = { ...empty, texts: { new: 0, unmatched: [] as string[], align_enqueued: 0 } };
  let waiting = false;
  for (const item of parsed.items) {
    if (exists.get(item.identity)) continue;
    const ep = findEpisodeByTitle(episodes, item.title, (e) => e.published_at !== null && item.published_at !== null && Math.abs(e.published_at - item.published_at) < TEXT_MATCH_WINDOW_MS);
    if (!ep) {
      report.texts.unmatched.push(item.title);
      if (item.published_at === null || ctx.now() - item.published_at < TEXT_MATCH_WINDOW_MS) waiting = true;
      continue;
    }
    const article = extractArticle(item.html, { title: item.title, date: item.published_at ? new Date(item.published_at).toISOString().slice(0, 10) : null });
    if (article.word_count < 50) { report.skipped.push({ title: item.title, reason: "no article body" }); continue; }
    const stored = storeEpisodeText(ctx, { episode: ep, source: "rss", source_ref: item.identity, article, received_at: item.published_at, align: feed.auto_process === 1 });
    report.texts.new++;
    if (stored.align_enqueued) report.texts.align_enqueued++;
  }
  if (waiting) ctx.db.prepare("UPDATE feed SET etag = NULL, last_modified = NULL WHERE id = ?").run(feed.id);
  ctx.log("text feed refreshed", { feed_id: feed.id, url: redact(fetched.url), items: parsed.items.length, new_texts: report.texts.new, unmatched: report.texts.unmatched.length, align_enqueued: report.texts.align_enqueued, waiting_for_episode: waiting });
  return report;
}

/** Job body: align an episode's publisher text to its audio and store the result as an `email` transcript. */
export async function alignTextJob(ctx: AppContext, job: Job<{ text_id: string }>): Promise<void> {
  const row = getEpisodeText(ctx, job.payload.text_id);
  if (!row) throw new NonRetryable("episode text not found");
  const episode = ctx.db.prepare("SELECT * FROM episode WHERE id = ?").get(row.episode_id) as EpisodeRow;
  const asset = episode.current_asset_id ? (ctx.db.prepare("SELECT * FROM audio_asset WHERE id = ?").get(episode.current_asset_id) as AudioAssetRow) : null;
  if (!asset) throw new DeferJob("episode has no stored audio yet");
  const existing = ctx.db.prepare("SELECT id FROM transcript WHERE audio_asset_id = ? AND text_id = ?").get(asset.id, row.id);
  if (existing) return;
  // One publisher-text alignment per recording is enough; a second source (email after rss, or the reverse) reuses it.
  const other = ctx.db.prepare("SELECT id, source FROM transcript WHERE audio_asset_id = ? AND source != 'asr'").get(asset.id) as { id: string; source: string } | undefined;
  if (other) {
    // Same article from another source: reuse its section timings when the headings match.
    const otherText = ctx.db.prepare("SELECT t.sections FROM transcript x JOIN episode_text t ON t.id = x.text_id WHERE x.id = ?").get(other.id) as { sections: string } | undefined;
    if (otherText) {
      const theirs = JSON.parse(otherText.sections) as { title: string; start_word?: number | null; start_ms?: number | null }[];
      const mine = JSON.parse(row.sections) as { title: string; first_paragraph: number }[];
      if (theirs.length === mine.length && theirs.every((s, i) => s.title === mine[i]!.title)) {
        const merged = mine.map((s, i) => ({ ...s, start_word: theirs[i]!.start_word ?? null, start_ms: theirs[i]!.start_ms ?? null }));
        ctx.db.prepare("UPDATE episode_text SET sections = ? WHERE id = ?").run(JSON.stringify(merged), row.id);
      }
    }
    ctx.log("text alignment skipped", { episode_id: episode.id, text_id: row.id, reason: `asset already aligned from ${other.source}` });
    return;
  }
  if (!ctx.aligner) throw new DeferJob("no forced-alignment adapter configured (set ELEVENLABS_API_KEY)");

  const result = await ctx.aligner.align({ path: asset.path, mime: asset.mime, duration_ms: asset.duration_ms, text: row.text });
  const article: Pick<ArticleText, "paragraphs" | "sections"> = { paragraphs: JSON.parse(row.paragraphs), sections: JSON.parse(row.sections) };
  const { words, sections } = attachParagraphs(row.text, article, result.words);
  const normalized = normalize({ provider: "elevenlabs", model: "forced_alignment", language: null, words, events: [] }, { duration_ms: asset.duration_ms, relabel_speakers: false });
  const transcript = storeTranscript(ctx, asset.id, normalized, {
    cost_cents: result.cost_cents,
    provider_request_id: undefined,
    source: row.source === "rss" ? "rss" : "email",
    text_id: row.id,
    loss: result.loss,
    make_current: false,
  });
  ctx.db.prepare("UPDATE episode_text SET sections = ? WHERE id = ?").run(JSON.stringify(sections), row.id);
  const current = applyTextPolicyForAsset(ctx, asset.id);
  if (current) {
    // The same follow-ups a new current transcript gets: wake snips that waited for one, and queue the episode summary.
    const waiting = ctx.db.prepare("SELECT r.id FROM snip_revision r JOIN snip s ON s.id = r.snip_id WHERE s.audio_asset_id = ? AND s.current_revision_id = r.id AND r.status = 'waiting'").pluck().all(asset.id) as string[];
    for (const revisionId of waiting) if (!ctx.queue.wake(`select_snip:${revisionId}`)) ctx.queue.enqueue("select_snip", `select_snip:${revisionId}`, { revision_id: revisionId }, { priority: PRIORITY.snip });
    ctx.queue.enqueue("summarize_episode", `summarize_episode:${asset.id}`, { asset_id: asset.id }, { priority: PRIORITY.catalog });
  }
  const high = result.words.filter((w) => w.loss > 1).length;
  ctx.log("text aligned", { episode_id: episode.id, transcript_id: transcript.id, words: normalized.word_count, loss: Number(result.loss.toFixed(3)), high_loss_words: high, cost_cents: result.cost_cents, elapsed_ms: result.elapsed_ms, current });
}

/**
 * Give each aligned word its paragraph's speaker and compute section start times. The aligner returns one entry per
 * whitespace token of the input in order; when counts disagree, tokens are matched by normalized text in order.
 */
export function attachParagraphs(text: string, article: Pick<ArticleText, "paragraphs" | "sections">, aligned: { text: string; start_ms: number; end_ms: number; loss: number }[]): { words: RawWord[]; sections: (ArticleText["sections"][number] & { start_word: number | null; start_ms: number | null })[] } {
  const paragraphTokens = article.paragraphs.map((p) => p.text.split(/\s+/).filter(Boolean));
  const owner: number[] = [];
  paragraphTokens.forEach((toks, pi) => { for (let k = 0; k < toks.length; k++) owner.push(pi); });
  const inputTokens = text.split(/\s+/).filter(Boolean);
  const same = aligned.length === inputTokens.length;
  const words: RawWord[] = [];
  const firstWordOfParagraph = new Map<number, number>();
  let ti = 0;
  for (const w of aligned) {
    let tokenIndex: number;
    if (same) tokenIndex = words.length;
    else {
      // walk forward to the next input token with the same normalized text; otherwise keep the running position
      const target = normalizeToken(w.text);
      let probe = ti;
      while (probe < inputTokens.length && probe < ti + 8 && normalizeToken(inputTokens[probe]!) !== target) probe++;
      tokenIndex = probe < inputTokens.length && probe < ti + 8 ? probe : ti;
      ti = Math.min(inputTokens.length - 1, tokenIndex + 1);
    }
    const pi = owner[Math.min(tokenIndex, owner.length - 1)] ?? -1;
    const paragraph = article.paragraphs[pi];
    const speaker = paragraph ? (paragraph.speaker ?? (paragraph.quote ? QUOTE_LABEL : undefined)) : undefined;
    if (paragraph && !firstWordOfParagraph.has(pi)) firstWordOfParagraph.set(pi, words.length);
    const word: RawWord = { text: w.text, start_ms: w.start_ms, end_ms: w.end_ms, confidence: Math.max(0, Math.min(1, 1 / (1 + w.loss))) };
    if (speaker) word.speaker = speaker;
    words.push(word);
  }
  const sections = article.sections.map((s) => {
    const wi = firstWordOfParagraph.get(s.first_paragraph);
    return { ...s, start_word: wi ?? null, start_ms: wi !== undefined ? words[wi]!.start_ms : null };
  });
  return { words, sections };
}
