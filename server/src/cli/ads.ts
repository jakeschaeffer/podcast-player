/**
 * Report the ad breaks the detector finds in recent episodes, with the words inside each break and the words it
 * resumes on, so the rules can be checked by reading. Reads the database only; calls no provider.
 *
 *   pnpm ads [--feed <title substring>] [--limit N] [--store]
 *
 * `--store` also writes the results, as the detect_ads job would.
 */
import { parseArgs } from "node:util";
import { createContext } from "../app/context.js";
import type { AudioAssetRow } from "../db/rows.js";
import { loadConfig } from "../lib/config.js";
import { computeAdBreaks, storeAdBreaks } from "../services/adBreaks.js";
import { loadTranscript } from "../services/transcripts.js";

const { values } = parseArgs({ options: { feed: { type: "string" }, limit: { type: "string", default: "10" }, store: { type: "boolean", default: false } } });
const ctx = createContext(loadConfig());
const rows = ctx.db
  .prepare(
    `SELECT e.title, f.title AS show, a.* FROM episode e JOIN feed f ON f.id = e.feed_id JOIN audio_asset a ON a.id = e.current_asset_id
     WHERE a.transcript_id IS NOT NULL AND (? IS NULL OR f.title LIKE '%' || ? || '%')
     ORDER BY e.published_at DESC LIMIT ?`,
  )
  .all(values.feed ?? null, values.feed ?? null, Number(values.limit)) as (AudioAssetRow & { title: string; show: string | null })[];

const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;
let total = 0;
for (const r of rows) {
  const { inputs, breaks } = computeAdBreaks(ctx, r);
  total += breaks.length;
  const kind = inputs.publisher ? (ctx.db.prepare("SELECT x.kind FROM transcript t JOIN episode_text x ON x.id = t.text_id WHERE t.id = ?").pluck().get(inputs.publisher) as string | null) : null;
  console.log(`\n${r.show ?? "?"} — ${r.title} (${clock(r.duration_ms)}; asr ${inputs.asr ? "yes" : "no"}, publisher text ${inputs.publisher ? kind ?? "yes" : "no"}, summary ${inputs.summary ? "yes" : "no"})`);
  if (breaks.length === 0) console.log("  no breaks");
  const words = inputs.asr ? loadTranscript(ctx, inputs.asr).segments.flatMap((s) => s.words) : [];
  for (const b of breaks) {
    const inside = words.filter((w) => w[0] >= b.start_ms && w[0] < b.end_ms).map((w) => w[2]);
    const next = words.filter((w) => w[0] >= b.end_ms).slice(0, 10).map((w) => w[2]);
    const text = inside.length > 60 ? `${inside.slice(0, 45).join(" ")} … ${inside.slice(-15).join(" ")}` : inside.join(" ");
    console.log(`  ${clock(b.start_ms)}–${clock(b.end_ms)} (${Math.round((b.end_ms - b.start_ms) / 1000)} s) ${b.confidence} [${b.sources.join(", ")}]${b.cue ? ` "${b.cue}"` : ""}`);
    console.log(`    ${text}`);
    console.log(`    resumes on: ${next.join(" ")}`);
  }
  if (values.store) storeAdBreaks(ctx, r.id, inputs, breaks);
}
console.log(`\n${rows.length} episodes, ${total} breaks${values.store ? ", stored" : ""}`);
ctx.db.close();
