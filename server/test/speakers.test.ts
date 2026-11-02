import type { Static, TSchema } from "@sinclair/typebox";
import { beforeAll, describe, expect, it } from "vitest";
import { parseAgainstSchema, type GenerateRequest, type GenerateResult, type TextModel } from "../src/adapters/textModel.js";
import { drain } from "../src/jobs/worker.js";
import { speakerNames, speakersFor } from "../src/services/speakers.js";
import { storeTranscript } from "../src/services/transcripts.js";
import { makeTone, recordingFixture } from "./helpers/fixture.js";
import { buildTranscript } from "./helpers/transcript.js";

/** Names the host from the author and the guest from the title, and remembers what it was shown. */
class SpeakersModel implements TextModel {
  readonly name = "speakers";
  prompts: string[] = [];
  async generate<S extends TSchema>(req: GenerateRequest<S>): Promise<GenerateResult<Static<S>>> {
    this.prompts.push(req.user);
    const answer = { speakers: [{ label: "S1", role: "host", name: "Ben Thompson" }, { label: "S2", role: "guest", name: "Shyam Sankar" }] };
    return { data: parseAgainstSchema(req.schema, answer), model: "speakers-model", elapsed_ms: 1 };
  }
}

let mp3: string;
beforeAll(async () => {
  mp3 = await makeTone();
});

describe("speakers job", () => {
  it("runs when a transcript is stored and keeps the answer with it", async () => {
    const model = new SpeakersModel();
    const { ctx, episodeId, assetId } = recordingFixture(mp3, { textModel: model });
    ctx.db.prepare("UPDATE feed SET author = 'Ben Thompson'").run();
    ctx.db.prepare("UPDATE episode SET title = 'An Interview with Palantir CTO Shyam Sankar' WHERE id = ?").run(episodeId);
    const row = storeTranscript(ctx, assetId, buildTranscript([
      { speaker: "a", text: "Welcome back. What does a CTO do?" },
      { speaker: "b", text: "Mostly we sit with customers." },
    ]), {});
    expect(speakersFor(ctx, row.id)).toBeNull();
    await drain(ctx, { kinds: ["identify_speakers"] });
    expect(model.prompts[0]).toContain("Author: Ben Thompson");
    expect(model.prompts[0]).toContain("Episode: An Interview with Palantir CTO Shyam Sankar");
    expect(speakersFor(ctx, row.id)).toEqual([{ label: "S1", role: "host", name: "Ben Thompson" }, { label: "S2", role: "guest", name: "Shyam Sankar" }]);
    expect(speakerNames(ctx, row.id)).toEqual({ S1: "Ben Thompson", S2: "Shyam Sankar" });
    await drain(ctx, { kinds: ["identify_speakers"] });
    expect(model.prompts).toHaveLength(1);
  });
});
