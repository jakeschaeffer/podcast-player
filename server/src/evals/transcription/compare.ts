/**
 * Compare transcripts of the same recording from two sources: Scribe (ASR) and publisher text aligned with
 * forced alignment. Reports how far the ASR text is from the published text (WER with the email as reference),
 * how closely the two timelines agree on words they share, and how much audio has no counterpart in the text.
 *
 *   pnpm eval:text:compare [--limit N]
 *
 * Writes evals/transcription/results/<timestamp>-email-vs-asr.{json,md}.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createContext } from "../../app/context.js";
import type { NormalizedTranscript } from "../../core/transcript/types.js";
import { loadConfig } from "../../lib/config.js";
import { loadTranscript } from "../../services/transcripts.js";
import { normalizeToken } from "../../core/transcript/tokens.js";
import { alignTokens, type Op } from "../../core/transcript/align.js";

export { alignTokens, type Op };

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT_DIR = join(REPO, "evals/transcription/results");

type Tok = { tok: string; start_ms: number; end_ms: number; raw: string; loss?: number };

function tokensOf(t: NormalizedTranscript): Tok[] {
  const out: Tok[] = [];
  for (const s of t.segments) for (const w of s.words) {
    const tok = normalizeToken(w[2]);
    if (tok) out.push({ tok, start_ms: w[0], end_ms: w[1], raw: w[2] });
  }
  return out;
}

function pctl(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
}

/** Maximal runs of a given op, at least `min` long: audio-only passages (ins) or unread text (del). */
function runs(ops: Op[], op: Op, min: number): number[] {
  const out: number[] = [];
  let run = 0;
  for (const o of ops) {
    if (o === op) run++;
    else { if (run >= min) out.push(run); run = 0; }
  }
  if (run >= min) out.push(run);
  return out;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { limit: { type: "string" } } });
  const ctx = createContext(loadConfig());
  const rows = ctx.db
    .prepare(
      `SELECT e.title AS episode_title, a.id AS asset_id, a.duration_ms, asr.id AS asr_id, em.id AS email_id, em.loss AS email_loss, em.cost_cents AS email_cost
       FROM audio_asset a JOIN episode e ON e.id = a.episode_id
       JOIN transcript asr ON asr.id = a.transcript_id AND asr.source = 'asr'
       JOIN transcript em ON em.audio_asset_id = a.id AND em.source != 'asr'
       ORDER BY e.published_at DESC`,
    )
    .all() as { episode_title: string; asset_id: string; duration_ms: number; asr_id: string; email_id: string; email_loss: number | null; email_cost: number | null }[];
  const picked = values.limit ? rows.slice(0, Number(values.limit)) : rows;
  if (picked.length === 0) { console.error("no assets have both an ASR and an email transcript"); process.exit(2); }

  const per: Record<string, unknown>[] = [];
  const allDeltas: number[] = [];
  for (const r of picked) {
    const asr = tokensOf(loadTranscript(ctx, r.asr_id));
    const email = tokensOf(loadTranscript(ctx, r.email_id));
    const a = alignTokens(email.map((t) => t.tok), asr.map((t) => t.tok));
    const wer = email.length ? (a.sub + a.del + a.ins) / email.length : 0;
    const alphaRef = email.filter((t) => !/\d/.test(t.tok)).map((t) => t.tok);
    const alphaHyp = asr.filter((t) => !/\d/.test(t.tok)).map((t) => t.tok);
    const b = alignTokens(alphaRef, alphaHyp);
    const alphaWer = alphaRef.length ? (b.sub + b.del + b.ins) / alphaRef.length : 0;
    const deltas = a.pairs.map(([ei, ai]) => email[ei]!.start_ms - asr[ai]!.start_ms);
    const absDeltas = deltas.map(Math.abs);
    allDeltas.push(...absDeltas);
    const tenth = Math.max(1, Math.floor(deltas.length / 10));
    const first = deltas.slice(0, tenth);
    const last = deltas.slice(-tenth);
    const med = (xs: number[]) => pctl(xs, 0.5);
    const audioOnly = runs(a.ops, "ins", 15);
    const unread = runs(a.ops, "del", 15);
    per.push({
      episode: r.episode_title,
      asset_id: r.asset_id,
      duration_s: Math.round(r.duration_ms / 1000),
      asr_words: asr.length,
      email_words: email.length,
      wer: Number(wer.toFixed(4)),
      alpha_wer: Number(alphaWer.toFixed(4)),
      sub: a.sub, del: a.del, ins: a.ins,
      matched: a.pairs.length,
      timing_median_ms: med(absDeltas),
      timing_p90_ms: pctl(absDeltas, 0.9),
      within_250ms: Number((absDeltas.filter((d) => d <= 250).length / Math.max(1, absDeltas.length)).toFixed(3)),
      drift_first_vs_last_ms: med(last) - med(first),
      audio_only_passages: audioOnly.length,
      audio_only_words: audioOnly.reduce((x, y) => x + y, 0),
      unread_passages: unread.length,
      unread_words: unread.reduce((x, y) => x + y, 0),
      alignment_loss: r.email_loss,
      email_cost_cents: r.email_cost,
    });
  }
  const agg = {
    episodes: per.length,
    hours: Number((per.reduce((x, p) => x + (p["duration_s"] as number), 0) / 3600).toFixed(1)),
    mean_wer: Number((per.reduce((x, p) => x + (p["wer"] as number), 0) / per.length).toFixed(4)),
    mean_alpha_wer: Number((per.reduce((x, p) => x + (p["alpha_wer"] as number), 0) / per.length).toFixed(4)),
    timing_median_ms: pctl(allDeltas, 0.5),
    timing_p90_ms: pctl(allDeltas, 0.9),
    within_250ms: Number((allDeltas.filter((d) => d <= 250).length / Math.max(1, allDeltas.length)).toFixed(3)),
    audio_only_words_per_episode: Math.round(per.reduce((x, p) => x + (p["audio_only_words"] as number), 0) / per.length),
    unread_words_per_episode: Math.round(per.reduce((x, p) => x + (p["unread_words"] as number), 0) / per.length),
    mean_alignment_loss: Number((per.reduce((x, p) => x + ((p["alignment_loss"] as number | null) ?? 0), 0) / per.length).toFixed(3)),
    email_cost_cents: per.reduce((x, p) => x + ((p["email_cost_cents"] as number | null) ?? 0), 0),
  };

  await mkdir(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  await writeFile(join(OUT_DIR, `${stamp}-email-vs-asr.json`), JSON.stringify({ run_at: new Date().toISOString(), aggregate: agg, episodes: per }, null, 1));
  const md = [
    `# Publisher text (forced-aligned) versus Scribe v2 on the same recordings`,
    ``,
    `Run ${new Date().toISOString()}. ${agg.episodes} episodes, ${agg.hours} hours. Reference for WER is the email text as the podcast reads it; insertions are audio with no text (intro line, ads, asides), deletions are text not spoken.`,
    ``,
    `| Episodes | Mean WER | Mean WER, letters only | Word-start agreement, median | p90 | Within 250 ms | Audio-only words per episode | Unread words per episode | Mean alignment loss | Alignment cost |`,
    `| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
    `| ${agg.episodes} | ${(agg.mean_wer * 100).toFixed(1)}% | ${(agg.mean_alpha_wer * 100).toFixed(1)}% | ${agg.timing_median_ms} ms | ${agg.timing_p90_ms} ms | ${(agg.within_250ms * 100).toFixed(0)}% | ${agg.audio_only_words_per_episode} | ${agg.unread_words_per_episode} | ${agg.mean_alignment_loss} | ${agg.email_cost_cents} ¢ |`,
    ``,
    `## Per episode`,
    ``,
    `| Episode | Length | ASR words | Email words | WER | Letters-only WER | Sub / Del / Ins | Timing median | p90 | Drift first→last | Audio-only passages (words) | Unread passages (words) | Loss |`,
    `| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- | --- | ---: |`,
    ...per.map((p) => `| ${String(p["episode"]).slice(0, 60)} | ${Math.round((p["duration_s"] as number) / 60)} min | ${p["asr_words"]} | ${p["email_words"]} | ${((p["wer"] as number) * 100).toFixed(1)}% | ${((p["alpha_wer"] as number) * 100).toFixed(1)}% | ${p["sub"]} / ${p["del"]} / ${p["ins"]} | ${p["timing_median_ms"]} ms | ${p["timing_p90_ms"]} ms | ${p["drift_first_vs_last_ms"]} ms | ${p["audio_only_passages"]} (${p["audio_only_words"]}) | ${p["unread_passages"]} (${p["unread_words"]}) | ${p["alignment_loss"] ?? "–"} |`),
    ``,
  ].join("\n");
  await writeFile(join(OUT_DIR, `${stamp}-email-vs-asr.md`), md);
  console.log(md);
  console.log(`\nwrote evals/transcription/results/${stamp}-email-vs-asr.{json,md}`);
  ctx.db.close();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err instanceof Error ? err.stack ?? err.message : String(err)); process.exit(1); });
}
