/**
 * Build segment → title eval cases.
 *
 *   pnpm eval:titles:build
 *
 * From the Readwise export (evals/snip-selection/fixtures/readwise): every Snipd snip with a transcript, its title,
 * and a guess at whether the owner wrote it (origin.ts). From this app's database: every title the owner edited
 * (the title_edit log), with the model's title for the same span. Writes evals/snip-titles/cases/{readwise,app-edits}.jsonl
 * (gitignored; they hold transcript text) and a count summary in evals/snip-titles/results/.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext } from "../../app/context.js";
import { loadConfig } from "../../lib/config.js";
import { slug } from "../snip-selection/cases.js";
import { appEditCases } from "./appEdits.js";
import type { TitleCase } from "./cases.js";
import { guessTitleOrigin } from "./origin.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = join(REPO, "evals/snip-titles");
const READWISE = join(REPO, "evals/snip-selection/fixtures/readwise/highlights.jsonl");

type Highlight = {
  highlight_id: number; url: string | null; highlighted_at: string | null; note: string | null;
  book: { title: string; author: string | null };
  derived: { record_kind?: string; snipd_snip_id?: string | null; title?: string | null; transcript?: string | null; turns?: { speaker: string; text: string }[] | null };
};

function wordCount(turns: { text: string }[]): number {
  return turns.reduce((n, t) => n + t.text.split(/\s+/).filter(Boolean).length, 0);
}

async function readwiseCases(): Promise<TitleCase[]> {
  if (!existsSync(READWISE)) return [];
  const lines = (await readFile(READWISE, "utf8")).split("\n").filter(Boolean);
  const seen = new Set<string>();
  const out: TitleCase[] = [];
  for (const line of lines) {
    const h = JSON.parse(line) as Highlight;
    if (h.derived.record_kind !== "snip" || !h.derived.title) continue;
    const key = h.derived.snipd_snip_id ?? String(h.highlight_id);
    if (seen.has(key)) continue;
    seen.add(key);
    const turns = h.derived.turns && h.derived.turns.length > 0 ? h.derived.turns.map((t) => ({ speaker: t.speaker || null, text: t.text.trim() })) : h.derived.transcript ? [{ speaker: null, text: h.derived.transcript.trim() }] : [];
    if (wordCount(turns) < 20) continue;
    const guess = guessTitleOrigin(h.derived.title);
    if (guess.origin === "placeholder") continue;
    const year = h.highlighted_at?.slice(0, 4) ?? "unknown";
    out.push({
      id: `rw-${h.highlight_id}`,
      source: "readwise",
      show: h.book.author,
      episode: h.book.title,
      excerpt: turns,
      excerpt_words: wordCount(turns),
      reference_title: h.derived.title.trim(),
      origin: guess.origin,
      origin_confidence: guess.confidence,
      origin_reasons: guess.reasons,
      ...(guess.generated_part ? { generated_part: guess.generated_part, other_model_title: guess.generated_part } : {}),
      ...(guess.owner_part ? { owner_part: guess.owner_part } : {}),
      meta: { readwise_highlight_id: h.highlight_id, snipd_url: h.url, highlighted_at: h.highlighted_at },
      tags: [`origin:${guess.origin}`, `show:${slug(h.book.author ?? "unknown")}`, `year:${year}`],
    });
  }
  return out;
}

function appCases(): TitleCase[] {
  const ctx = createContext(loadConfig());
  try {
    return appEditCases(ctx);
  } finally {
    ctx.db.close();
  }
}

async function main(): Promise<void> {
  const rw = await readwiseCases();
  const app = appCases();
  await mkdir(join(OUT, "cases"), { recursive: true });
  await mkdir(join(OUT, "results"), { recursive: true });
  await writeFile(join(OUT, "cases/readwise.jsonl"), rw.map((c) => JSON.stringify(c)).join("\n") + (rw.length ? "\n" : ""));
  await writeFile(join(OUT, "cases/app-edits.jsonl"), app.map((c) => JSON.stringify(c)).join("\n") + (app.length ? "\n" : ""));
  const count = (xs: TitleCase[], f: (c: TitleCase) => string) => xs.reduce<Record<string, number>>((m, c) => ((m[f(c)] = (m[f(c)] ?? 0) + 1), m), {});
  const summary = {
    built_at: new Date().toISOString(),
    readwise: { cases: rw.length, by_origin: count(rw, (c) => `${c.origin}/${c.origin_confidence}`), owner_written: rw.filter((c) => c.origin === "manual" || c.origin === "appended").length },
    app_edits: { cases: app.length },
    by_show: count([...rw, ...app].filter((c) => c.origin !== "generated"), (c) => c.show ?? "unknown"),
  };
  await writeFile(join(OUT, `results/build-${summary.built_at.slice(0, 10)}.json`), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary, null, 1));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
}
