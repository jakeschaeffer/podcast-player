import type { Static, TSchema } from "@sinclair/typebox";
import { beforeAll, describe, expect, it } from "vitest";
import { parseAgainstSchema, type GenerateRequest, type GenerateResult, type TextModel } from "../src/adapters/textModel.js";
import type { AppContext } from "../src/app/context.js";
import { readRegistry } from "../src/core/summary/prompts.js";
import type { SnipRevisionRow } from "../src/db/rows.js";
import { drain } from "../src/jobs/worker.js";
import { newId } from "../src/lib/ids.js";
import { getPrompt } from "../src/services/prompts.js";
import { createSnip, deleteSnip, editSnip } from "../src/services/snips.js";
import { storeTranscript } from "../src/services/transcripts.js";
import { makeTone, PRICING, recordingFixture, transcriptAbout } from "./helpers/fixture.js";

class TitleModel implements TextModel {
  readonly name = "titles";
  async generate<S extends TSchema>(req: GenerateRequest<S>): Promise<GenerateResult<Static<S>>> {
    return { data: parseAgainstSchema(req.schema, { title: "Usage pricing doubled revenue", bullets: [{ text: "Switching to usage based pricing doubles revenue.", sentence_ids: [0] }], quote: "" }), model: "title-model", elapsed_ms: 1 };
  }
}

/**
 * The Prompts screen's production numbers: of the snips a prompt version (or the fixed rules) wrote for, how many the
 * owner then changed. They come from what is already stored: the title log and the snips' revisions.
 */
describe("edit rates per prompt version", () => {
  let ctx: AppContext;
  let assetId: string;
  const active = readRegistry()["snip-summary"].active;

  const snipAt = (anchor_ms: number) => createSnip(ctx, { client_request_id: newId(), asset_id: assetId, anchor_ms, heard_from_ms: 0 }, null).snip;
  const current = (snipId: string) => ctx.db.prepare("SELECT r.* FROM snip_revision r JOIN snip s ON s.current_revision_id = r.id WHERE s.id = ?").get(snipId) as SnipRevisionRow;

  beforeAll(async () => {
    ({ ctx, assetId } = recordingFixture(await makeTone(), { textModel: new TitleModel() }));
    storeTranscript(ctx, assetId, transcriptAbout(PRICING), {});
    const kept = snipAt(100_000).id;
    const retitled = snipAt(104_000).id;
    const moved = snipAt(108_000).id;
    const both = snipAt(112_000).id;
    const gone = snipAt(116_000).id;
    await drain(ctx);
    expect(current(kept)).toMatchObject({ title_source: "model", summary_prompt_version: active });

    editSnip(ctx, retitled, { title: "Flat fees left money on the table" }, null);
    editSnip(ctx, retitled, { title: "Flat fees left money on the table, twice over" }, null); // the same snip again: still one
    const span = current(moved);
    editSnip(ctx, moved, { start_ms: span.start_ms - 15_000, end_ms: span.end_ms, if_revision: span.id }, null);
    // A title written while fine-tuning the boundaries: a rewrite, and too small a move to count as one.
    const tuned = current(both);
    editSnip(ctx, both, { start_ms: tuned.start_ms, end_ms: tuned.end_ms, if_revision: tuned.id, title: "Nobody upgraded" }, null);
    // A deleted snip counts for nothing, whatever was done to it first.
    editSnip(ctx, gone, { title: "Deleted afterwards" }, null);
    deleteSnip(ctx, gone);
    await drain(ctx);
    snipAt(90_000); // tapped just now: no span chosen, no title written
  });

  it("counts the titles the owner rewrote against the version that wrote them", () => {
    const prompt = getPrompt(ctx, "snip-summary");
    expect(prompt.edits_label).toBe("titles rewritten");
    expect(prompt.rules_edits).toBeNull();
    expect(prompt.versions.find((v) => v.version === active)!.edits).toEqual({ snips: 4, edited: 2 });
    for (const v of prompt.versions.filter((v) => v.version !== active)) expect(v.edits).toBeNull();
  });

  it("counts the spans the owner moved against the fixed rules while the start picker is off", () => {
    const prompt = getPrompt(ctx, "span-picker");
    expect(prompt.edits_label).toBe("spans moved");
    expect(prompt.rules_edits).toEqual({ snips: 4, edited: 1 });
    for (const v of prompt.versions) expect(v.edits).toBeNull();
  });

  it("says nothing for prompts whose output the owner cannot edit", () => {
    const prompt = getPrompt(ctx, "episode-summary");
    expect(prompt).toMatchObject({ edits_label: null, rules_edits: null });
    for (const v of prompt.versions) expect(v.edits).toBeNull();
  });
});
