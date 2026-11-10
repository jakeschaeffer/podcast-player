import type { AppContext } from "../../app/context.js";
import { sentencize, type Sentence } from "../../core/snip/sentencize.js";
import { wordRangeByMidpoint } from "../../core/snip/select.js";
import type { NormalizedTranscript } from "../../core/transcript/types.js";
import { chosenSpans, SAME_SPAN_MS } from "../../services/snipEdits.js";
import { loadTranscript } from "../../services/transcripts.js";
import { acceptableRanges, slug, wordsBucket, type SnipCase } from "./cases.js";

export type AppCases = {
  cases: SnipCase[];
  /** The transcript each case's selector saw, by the case's `transcript_fixture` key, with the recording's length. */
  transcripts: Map<string, { t: NormalizedTranscript; duration_ms: number }>;
};

/**
 * Selection cases from the snips made in the app. Each has the real tap (where it was, and how far back the listener
 * had heard), the transcript the selector saw, and as its label the span the owner left the snip with. A snip whose
 * boundaries the owner moved is exact ground truth. One left alone is weaker, since nothing says it was looked at; it
 * still shows what a new selector would change that nobody asked for. The two are tagged apart and scored apart.
 *
 * Read fresh from the database at run time, like the title eval's app edits, so the set grows as snips are made.
 */
export function appSnipCases(ctx: AppContext): AppCases {
  const loaded = new Map<string, { t: NormalizedTranscript; sentences: Sentence[] }>();
  const out: AppCases = { cases: [], transcripts: new Map() };

  for (const { snip, first, current, edited, start_moved_ms: startMoved, end_moved_ms: endMoved, selector } of chosenSpans(ctx)) {
    // A span cut without a transcript (the fixed fallback) has nothing for a selector to be scored on.
    if (!first.transcript_id) continue;

    let entry = loaded.get(first.transcript_id);
    if (!entry) {
      const t = loadTranscript(ctx, first.transcript_id);
      entry = { t, sentences: sentencize(t) };
      loaded.set(first.transcript_id, entry);
    }
    // The label is in milliseconds on the recording, which holds whatever transcript the owner edited against.
    const words = wordRangeByMidpoint(entry.t, current.start_ms, current.end_ms);
    if (!words) continue;
    const startIdx = entry.sentences.findIndex((s) => words.start_word >= s.start_word && words.start_word < s.end_word);
    const lastIdx = entry.sentences.findIndex((s) => words.end_word - 1 >= s.start_word && words.end_word - 1 < s.end_word);
    if (startIdx < 0 || lastIdx < 0) continue;

    const fixture = `db:${first.transcript_id}`;
    out.transcripts.set(fixture, { t: entry.t, duration_ms: snip.duration_ms });
    out.cases.push({
      id: `app-${snip.id.toLowerCase()}`,
      transcript_fixture: fixture,
      anchor_ms: snip.anchor_ms,
      heard_from_ms: snip.heard_from_ms,
      label: {
        idea: [current.title, snip.show_title].filter(Boolean).join(" · ") || snip.episode_title,
        ideal_start_word: words.start_word,
        ideal_end_word: words.end_word,
        ideal_start_ms: current.start_ms,
        ideal_end_ms: current.end_ms,
        ...acceptableRanges(entry.sentences, startIdx, lastIdx),
      },
      source: { kind: "app", snip_id: snip.id, episode_id: snip.episode_id, asset_id: snip.audio_asset_id, edited, chosen: { method: first.method, selector, start_ms: first.start_ms, end_ms: first.end_ms } },
      tags: [
        "source:app",
        edited ? "app:edited" : "app:left-alone",
        ...(edited && startMoved < -SAME_SPAN_MS ? ["app:start-earlier"] : []),
        ...(edited && startMoved > SAME_SPAN_MS ? ["app:start-later"] : []),
        ...(edited && Math.abs(endMoved) > SAME_SPAN_MS ? ["app:end-moved"] : []),
        `show:${slug(snip.show_title ?? "unknown")}`,
        wordsBucket(words.end_word - words.start_word),
      ],
    });
  }
  return out;
}

/** What the owner did to an app case's span, for the run's case list: "Start 69 s earlier", "Left as chosen". */
export function editNote(c: SnipCase): string | null {
  if (!("kind" in c.source) || c.source.kind !== "app") return null;
  if (!c.source.edited) return "Left as chosen";
  const part = (name: string, ms: number) => (Math.abs(ms) > SAME_SPAN_MS ? `${name} ${Math.round(Math.abs(ms) / 1000)} s ${ms < 0 ? "earlier" : "later"}` : null);
  return [part("Start", c.label.ideal_start_ms - c.source.chosen.start_ms), part("End", c.label.ideal_end_ms - c.source.chosen.end_ms)].filter(Boolean).join(", ") || "Moved";
}
