import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAgainstSchema, type TextModel } from "../src/adapters/textModel.js";
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
    // The ceilings are a picker that knows the answer: offered the owner's start, it takes it, and it leaves a span
    // nobody moved where it was. (That a wide reach offers starts the near one cannot is select.test.ts's to show.)
    const ceiling = (method: string) => data.rows.find((r) => r.method === method && r.case_id === `app-${edited.toLowerCase()}`)!;
    expect(ceiling("ceiling-240s")).toMatchObject({ start_hit: true, both: true });
    expect(data.by_tag["app:left-alone"]!["ceiling-near"]).toMatchObject({ both: "100%" });
    expect(data.by_tag["app:left-alone"]!["ceiling-240s"]).toMatchObject({ both: "100%" });

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

  it("gives a later prompt version its reach, and keeps its picks apart from v1's in the cache", async () => {
    // Picks the earliest sentence it is told it may: a start no v1 picker could have been offered.
    const seen: string[] = [];
    const earliest: TextModel = {
      name: "earliest",
      async generate(req) {
        seen.push(req.user);
        const from = Number(/any sentence from (\d+) to/.exec(req.user)![1]);
        return { data: parseAgainstSchema(req.schema, { start_id: from, reason: "as early as allowed" }), model: "earliest", elapsed_ms: 1 };
      },
    };
    const stamp = "2026-01-02T03-04-06";
    await runSelectionEval({ app: appSnipCases(ctx), stamp, model: earliest, modelLabel: "snap-90+model (earliest)", version: "v2" });
    const dir = join(process.env.EVALS_DIR!, "snip-selection/results");
    const data = JSON.parse(readFileSync(join(dir, `${stamp}-selection.json`), "utf8")) as { meta: { prompt: string }; rows: { case_id: string; method: string; selection_method: string; start_ms: number; violations: string[] }[] };
    expect(data.meta.prompt).toBe("v2");
    expect(seen).toHaveLength(2);
    const rows = data.rows.filter((r) => r.method === "snap-90+model (earliest)");
    for (const r of rows) {
      expect(r.selection_method).toBe("model");
      expect(r.violations).toEqual([]);
      // From the top of the recording: further back than the default 90 s, which is all v1 was shown around.
      expect(r.start_ms).toBeLessThan(15_000);
    }
    const keys = readFileSync(join(dir, "model-picks.jsonl"), "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { key: string }).key);
    expect(keys.filter((k) => k.includes("(earliest)|v2|reach240000|")).length).toBe(2);
  });
  it("scores what an episode map's rules would choose, making each transcript's map once", async () => {
    // Marks every tenth sentence as the start of a thought.
    let calls = 0;
    const everyTenth: TextModel = {
      name: "every-tenth",
      async generate(req) {
        calls++;
        const ids = [...req.user.matchAll(/^\[(\d+)\] /gm)].map((m) => Number(m[1])).filter((id) => id % 10 === 0);
        return { data: parseAgainstSchema(req.schema, { thoughts: [...ids, 99_999].map((start_id) => ({ start_id, title: `Thought ${start_id}`, major: false })) }), model: "every-tenth", elapsed_ms: 1 };
      },
    };
    const run = async (stamp: string) => {
      await runSelectionEval({ app: appSnipCases(ctx), stamp, map: { model: everyTenth, label: "every-tenth" } });
      const file = join(process.env.EVALS_DIR!, "snip-selection/results", `${stamp}-selection.json`);
      return (JSON.parse(readFileSync(file, "utf8")) as { rows: { method: string; selection_method: string; violations: string[] }[] }).rows;
    };
    const rows = await run("2026-01-02T03-04-07");
    expect(calls).toBe(1); // both snips are in one recording
    for (const rule of ["passage", "nearest-default", "latest", "second-latest", "latest-major", "ceiling"]) {
      const mine = rows.filter((r) => r.method === `map-${rule}`);
      expect(mine).toHaveLength(2);
      for (const r of mine) expect(r.violations).toEqual([]);
    }
    // A marked start was on offer, so the rule's choice was taken as a model's would be.
    expect(rows.filter((r) => r.method === "map-latest").every((r) => r.selection_method === "model")).toBe(true);
    await run("2026-01-02T03-04-08");
    expect(calls).toBe(1); // the map came from the cache
  });

});
