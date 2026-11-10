import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TextModel } from "../src/adapters/textModel.js";
import type { AppContext } from "../src/app/context.js";
import type { SnipRevisionRow } from "../src/db/rows.js";
import { appSnipCases } from "../src/evals/snip-selection/appSnips.js";
import { isAppCase } from "../src/evals/snip-selection/cases.js";
import { runSelectionEval } from "../src/evals/snip-selection/run.js";
import { drain } from "../src/jobs/worker.js";
import { newId } from "../src/lib/ids.js";
import { getRun } from "../src/services/evalRuns.js";
import { createSnip, deleteSnip, editSnip } from "../src/services/snips.js";
import { storeTranscript } from "../src/services/transcripts.js";
import { makeTone, PRICING, recordingFixture, transcriptAbout } from "./helpers/fixture.js";

/** A start picker that is down: every case falls back to the fixed rules, which is all these tests need of it. */
class DownModel implements TextModel {
  readonly name = "down";
  async generate(): Promise<never> {
    throw new Error("ECONNRESET");
  }
}

/**
 * Snips made in the app are selection-eval cases: the real tap, and as the label the span the owner left. These tests
 * pin which snips qualify, how an edited one differs from one left alone, and that a run scores and reports them.
 */
describe("selection eval cases from the app's snips", () => {
  let ctx: AppContext;
  let assetId: string;
  let leftAlone: string;
  let edited: string;
  let editedRev: SnipRevisionRow;

  const snipAt = (anchor_ms: number) => createSnip(ctx, { client_request_id: newId(), asset_id: assetId, anchor_ms, heard_from_ms: 0 }, null).snip;
  const current = (snipId: string) => ctx.db.prepare("SELECT r.* FROM snip_revision r JOIN snip s ON s.current_revision_id = r.id WHERE s.id = ?").get(snipId) as SnipRevisionRow;

  beforeAll(async () => {
    process.env.EVALS_DIR = mkdtempSync(join(tmpdir(), "pp-evals-"));
    ({ ctx, assetId } = recordingFixture(await makeTone()));
    storeTranscript(ctx, assetId, transcriptAbout(PRICING), {});
    leftAlone = snipAt(100_000).id;
    edited = snipAt(110_000).id;
    const deleted = snipAt(105_000).id;
    await drain(ctx);
    deleteSnip(ctx, deleted);
    // The owner pulls the start well back, as most real edits do, and leaves the end.
    const chosen = current(edited);
    editSnip(ctx, edited, { start_ms: chosen.start_ms - 15_000, end_ms: chosen.end_ms, if_revision: chosen.id }, null);
    await drain(ctx);
    editedRev = current(edited);
    snipAt(90_000); // tapped just now: nothing has chosen its span yet
  });
  afterAll(() => {
    delete process.env.EVALS_DIR;
  });

  it("takes every live snip whose span is settled, labelled with the span the owner left", () => {
    const { cases, transcripts } = appSnipCases(ctx);
    expect(cases.map((c) => c.id).sort()).toEqual([`app-${edited.toLowerCase()}`, `app-${leftAlone.toLowerCase()}`].sort());
    const byId = new Map(cases.map((c) => [c.id, c]));

    const alone = byId.get(`app-${leftAlone.toLowerCase()}`)!;
    expect(alone.tags).toEqual(expect.arrayContaining(["source:app", "app:left-alone", "show:fixture-show"]));
    expect(alone.tags).not.toContain("app:edited");
    expect(alone).toMatchObject({ anchor_ms: 100_000, heard_from_ms: 0, source: { kind: "app", edited: false } });

    const moved = byId.get(`app-${edited.toLowerCase()}`)!;
    expect(moved.tags).toEqual(expect.arrayContaining(["source:app", "app:edited", "app:start-earlier"]));
    expect(moved.tags).not.toContain("app:end-moved");
    expect(moved.label).toMatchObject({ ideal_start_ms: editedRev.start_ms, ideal_end_ms: editedRev.end_ms });
    expect(moved.label.acceptable_start_ms[0]).toBeLessThanOrEqual(editedRev.start_ms);
    expect(moved.label.acceptable_start_ms[1]).toBeGreaterThan(editedRev.start_ms);
    // The selector saw the transcript, so the run needs no fixture file for it.
    expect(isAppCase(moved) && moved.source.chosen.start_ms - editedRev.start_ms).toBeGreaterThan(14_000);
    expect(transcripts.get(moved.transcript_fixture)?.duration_ms).toBe(120_000);
  });

  it("scores them with no Readwise case files: the rule that chose a span reproduces it, and misses the one the owner moved", async () => {
    const stamp = "2026-01-02T03-04-05";
    const { meta } = await runSelectionEval({ app: appSnipCases(ctx), stamp, model: new DownModel(), modelLabel: "snap-90+model (down)" });
    expect(meta).toMatchObject({ cases: 2, snips: 2, app_cases: 2, app_edited: 1 });

    const dir = join(process.env.EVALS_DIR!, "snip-selection/results");
    const data = JSON.parse(readFileSync(join(dir, `${stamp}-selection.json`), "utf8")) as { rows: { case_id: string; method: string; both: boolean; start_hit: boolean; end_hit: boolean }[]; by_tag: Record<string, Record<string, { n: number; both: string }>> };
    const row = (id: string) => data.rows.find((r) => r.method === "snap-90" && r.case_id === `app-${id.toLowerCase()}`)!;
    expect(row(leftAlone)).toMatchObject({ both: true });
    expect(row(edited)).toMatchObject({ start_hit: false, end_hit: true, both: false });
    expect(data.by_tag["app:edited"]!["snap-90"]).toMatchObject({ n: 1, both: "0%" });
    expect(data.by_tag["app:left-alone"]!["snap-90"]).toMatchObject({ n: 1, both: "100%" });

    // The scorecard is committed, so it carries counts and rates and none of the snips' own words.
    const md = readFileSync(join(dir, `${stamp}-selection.md`), "utf8");
    expect(md).toContain("2 snips made in the app (1 with boundaries the owner moved)");
    expect(md).toContain("| app:edited | 1 |");
    expect(md).not.toContain("flat monthly fee");
    expect(md).not.toContain(edited.toLowerCase());

    // The Prompts screen's case list says what each snip is and what the owner did to it.
    const { run, cases } = getRun(ctx, "selection", stamp);
    expect(run.score).toMatchObject({ passed: 1, n: 2 });
    expect(cases[0]).toMatchObject({ id: `app-${edited.toLowerCase()}`, pass: false, note: "Start 15 s earlier" });
    expect(cases[0]!.expected).toContain("Fixture Show");
    expect(cases[1]).toMatchObject({ id: `app-${leftAlone.toLowerCase()}`, pass: true, note: "Left as chosen" });
  });
});
