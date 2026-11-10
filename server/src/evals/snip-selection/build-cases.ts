/**
 * Build snip-selection eval cases from the Readwise export.
 *
 *   pnpm eval:snips:build [--show Stratechery] [--min-coverage 0.7] [--transcript-source asr|text]
 *
 * --transcript-source text aligns the snips to the publisher-text transcript instead of the ASR one and writes to
 * cases-text/ and fixtures/transcripts-text/, so the two can be scored side by side.
 *
 * For every Snipd snip of the show whose episode has a transcript in the database: align the snip's
 * transcript text to our words, find the sentence it ends in, and emit one case per anchor position
 * inside that sentence (the owner's rule: the button was pressed within the snip's last sentence),
 * plus one anchor three seconds after it for reaction delay.
 *
 * Writes evals/snip-selection/cases/<id>.json, evals/snip-selection/fixtures/transcripts/<asset_id>.transcript.json,
 * and a build report under evals/snip-selection/results/.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createContext } from "../../app/context.js";
import { sentencize, type Sentence } from "../../core/snip/sentencize.js";
import { toApiTranscript, type NormalizedTranscript } from "../../core/transcript/types.js";
import type { AudioAssetRow, EpisodeRow } from "../../db/rows.js";
import { loadConfig } from "../../lib/config.js";
import { loadTranscript } from "../../services/transcripts.js";
import { findEpisodeByTitle } from "../../services/titleMatch.js";
import { alignSnip } from "./align.js";
import { acceptableRanges, slug, wordsBucket, type ReadwiseSource, type SnipCase } from "./cases.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const EVAL_DIR = join(REPO, "evals/snip-selection");
const ANCHORS: (number | "after")[] = [0.25, 0.5, 0.75, 1.0, "after"];

type Highlight = {
  highlight_id: number;
  text: string;
  url: string | null;
  highlighted_at: string | null;
  location: number | null;
  location_type: string | null;
  book: { title: string; author: string | null };
  derived: { record_kind?: string; snipd_snip_id?: string | null; start_offset_seconds?: number | null; transcript?: string | null; turns?: { speaker: string; text: string }[] | null; title?: string | null; duplicate_highlight_ids?: number[] };
};

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { show: { type: "string", default: "Stratechery" }, "min-coverage": { type: "string", default: "0.7" }, "transcript-source": { type: "string", default: "asr" } } });
  const useText = values["transcript-source"] === "text";
  const casesDir = useText ? "cases-text" : "cases";
  const fixturesDir = useText ? "fixtures/transcripts-text" : "fixtures/transcripts";
  const show = values.show!.toLowerCase();
  const minCoverage = Number(values["min-coverage"]);
  const ctx = createContext(loadConfig());

  const lines = (await readFile(join(EVAL_DIR, "fixtures/readwise/highlights.jsonl"), "utf8")).split("\n").filter(Boolean);
  const all = lines.map((l) => JSON.parse(l) as Highlight);
  const seen = new Set<string>();
  const snips = all.filter((h) => {
    if (h.derived.record_kind !== "snip") return false;
    if (!(h.book.author ?? "").toLowerCase().includes(show)) return false;
    const key = h.derived.snipd_snip_id ?? String(h.highlight_id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const episodes = ctx.db.prepare("SELECT * FROM episode").all() as EpisodeRow[];
  const hasTranscript = (e: EpisodeRow) => {
    if (!e.current_asset_id) return false;
    const a = ctx.db.prepare("SELECT transcript_id FROM audio_asset WHERE id = ?").get(e.current_asset_id) as { transcript_id: string | null } | undefined;
    return !!a?.transcript_id;
  };
  const transcripts = new Map<string, { t: NormalizedTranscript; sentences: Sentence[]; asset: AudioAssetRow }>();
  const report = { show: values.show, snips: snips.length, built: 0, cases: 0, no_text: 0, no_episode: 0, no_transcript: 0, unaligned: 0, low_coverage: [] as { highlight_id: number; coverage: number; length_ratio: number }[], episodes: new Set<string>() };

  await mkdir(join(EVAL_DIR, casesDir), { recursive: true });
  await mkdir(join(EVAL_DIR, fixturesDir), { recursive: true });
  await mkdir(join(EVAL_DIR, "results"), { recursive: true });

  for (const h of snips) {
    const text = h.derived.turns && h.derived.turns.length > 0 ? h.derived.turns.map((t) => t.text).join("\n") : h.derived.transcript ?? "";
    if (text.split(/\s+/).filter(Boolean).length < 8) { report.no_text++; continue; }
    const ep = findEpisodeByTitle(episodes, h.book.title, hasTranscript);
    if (!ep) { report.no_episode++; continue; }
    const asset = ep.current_asset_id ? (ctx.db.prepare("SELECT * FROM audio_asset WHERE id = ?").get(ep.current_asset_id) as AudioAssetRow) : null;
    if (!asset) { report.no_transcript++; continue; }
    const transcriptId = useText
      ? ((ctx.db.prepare("SELECT id FROM transcript WHERE audio_asset_id = ? AND source != 'asr' ORDER BY created_at DESC LIMIT 1").get(asset.id) as { id: string } | undefined)?.id ?? null)
      : ((ctx.db.prepare("SELECT id FROM transcript WHERE audio_asset_id = ? AND source = 'asr' ORDER BY created_at DESC LIMIT 1").get(asset.id) as { id: string } | undefined)?.id ?? null);
    if (!transcriptId) { report.no_transcript++; continue; }
    let entry = transcripts.get(asset.id);
    if (!entry) {
      const t = loadTranscript(ctx, transcriptId);
      entry = { t, sentences: sentencize(t), asset };
      transcripts.set(asset.id, entry);
      const fixture = join(EVAL_DIR, fixturesDir, `${asset.id}.transcript.json`);
      await writeFile(fixture, JSON.stringify({ ...toApiTranscript(t, { id: transcriptId, asset_id: asset.id }), duration_ms: asset.duration_ms, episode_title: ep.title, show_title: h.book.author }));
    }
    const offset = h.derived.start_offset_seconds ?? (h.location_type === "time_offset" ? h.location : null);
    const a = alignSnip(entry.t, text, offset !== null && offset !== undefined ? { start_offset_ms: offset * 1000 } : {});
    if (!a) { report.unaligned++; continue; }
    if (a.coverage < minCoverage || a.length_ratio < 0.6 || a.length_ratio > 1.6) {
      report.low_coverage.push({ highlight_id: h.highlight_id, coverage: Number(a.coverage.toFixed(2)), length_ratio: Number(a.length_ratio.toFixed(2)) });
      continue;
    }

    const sentences = entry.sentences;
    const lastIdx = sentences.findIndex((s) => a.end_word - 1 >= s.start_word && a.end_word - 1 < s.end_word);
    const startIdx = sentences.findIndex((s) => a.start_word >= s.start_word && a.start_word < s.end_word);
    if (lastIdx < 0 || startIdx < 0) { report.unaligned++; continue; }
    const last = sentences[lastIdx]!;
    const endsMidSentence = a.end_word < last.end_word - 1;
    const year = h.highlighted_at ? h.highlighted_at.slice(0, 4) : "unknown";
    const idea = (h.derived.title ?? text).replace(/\s+/g, " ").trim().slice(0, 120);
    const base: Omit<SnipCase, "id" | "anchor_ms" | "source" | "tags"> & { source: Omit<ReadwiseSource, "anchor_position">; tags: string[] } = {
      transcript_fixture: `${fixturesDir}/${asset.id}.transcript.json`,
      heard_from_ms: 0,
      label: {
        idea,
        ideal_start_word: a.start_word,
        ideal_end_word: a.end_word,
        ideal_start_ms: a.start_ms,
        ideal_end_ms: a.end_ms,
        ...acceptableRanges(sentences, startIdx, lastIdx),
      },
      source: {
        readwise_highlight_id: h.highlight_id,
        snipd_url: h.url,
        readwise_offset_s: offset ?? null,
        episode_id: ep.id,
        asset_id: asset.id,
        alignment: { coverage: Number(a.coverage.toFixed(3)), length_ratio: Number(a.length_ratio.toFixed(3)), snip_tokens: a.snip_tokens },
      },
      tags: [`show:${slug(h.book.author ?? "unknown")}`, `year:${year}`, wordsBucket(a.snip_tokens), endsMidSentence ? "ends-mid-sentence" : "ends-at-sentence"],
    };
    for (const pos of ANCHORS) {
      const anchor = pos === "after" ? Math.min(asset.duration_ms, last.end_ms + 3000) : Math.round(last.start_ms + pos * (last.end_ms - last.start_ms));
      const c: SnipCase = {
        id: `${slug(h.book.author ?? "show")}-${ep.id.slice(-6).toLowerCase()}-${h.highlight_id}-${pos === "after" ? "after" : `a${Math.round(pos * 100)}`}`,
        ...base,
        anchor_ms: anchor,
        source: { ...base.source, anchor_position: pos },
        tags: [...base.tags, `anchor:${pos === "after" ? "after" : Math.round(pos * 100)}`],
      };
      await writeFile(join(EVAL_DIR, casesDir, `${c.id}.json`), JSON.stringify(c, null, 1));
      report.cases++;
    }
    report.built++;
    report.episodes.add(ep.id);
  }

  const out = { ...report, transcript_source: useText ? "text" : "asr", episodes: report.episodes.size, built_at: new Date().toISOString() };
  await writeFile(join(EVAL_DIR, "results", `build-${new Date().toISOString().slice(0, 10)}${useText ? "-text" : ""}.json`), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
  ctx.db.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
