import { describe, expect, it } from "vitest";
import { buildTranscript } from "../../../test/helpers/transcript.js";
import { speakerDisplayName, speakerSamples, validateSpeakers, type SpeakersInput } from "./identify.js";

const t = buildTranscript([
  { speaker: "ben", text: "Welcome to Stratechery. My guest today is Shyam Sankar. What does a CTO at Palantir do?" },
  { speaker: "shyam", text: "A lot of it is about deploying software where it matters. We sit with customers." },
  { speaker: "ben", text: "How do you think about that?" },
  { speaker: "clip", text: "This is a clip from another show." },
]);
const input: SpeakersInput = {
  show_title: "Stratechery", author: "Ben Thompson", episode_title: "An Interview with Palantir CTO Shyam Sankar About the AI Buildout",
  description_text: "An interview with Shyam Sankar.", labels: speakerSamples(t),
};

describe("speakers", () => {
  it("samples each label in order of appearance with its share, turns and questions", () => {
    expect(input.labels.map((l) => [l.label, l.turns, l.questions])).toEqual([["S1", 2, 2], ["S2", 1, 0], ["S3", 1, 0]]);
    expect(input.labels.reduce((n, l) => n + l.share, 0)).toBeCloseTo(1, 1);
    expect(input.labels[0]!.lines[0]).toMatch(/^Welcome to Stratechery/);
  });

  it("accepts names the publisher gives and rejects invented ones, missing labels and named others", () => {
    const good = { speakers: [{ label: "S1", role: "host" as const, name: "Ben Thompson" }, { label: "S2", role: "guest" as const, name: "Shyam Sankar" }, { label: "S3", role: "other" as const, name: "" }] };
    expect(validateSpeakers(good, input)).toEqual([]);
    expect(validateSpeakers({ speakers: [good.speakers[0]!, { label: "S2", role: "guest", name: "Alex Karp" }, good.speakers[2]!] }, input)).toEqual([expect.stringMatching(/"Alex Karp".*not in the author/)]);
    expect(validateSpeakers({ speakers: good.speakers.slice(0, 2) }, input)).toEqual([expect.stringMatching(/missing: S3/)]);
    expect(validateSpeakers({ speakers: [...good.speakers, { label: "S9", role: "other", name: "" }] }, input)).toEqual([expect.stringMatching(/S9 is not a label/)]);
    expect(validateSpeakers({ speakers: [good.speakers[0]!, good.speakers[1]!, { label: "S3", role: "other", name: "Ben Thompson" }] }, input)).toEqual([expect.stringMatching(/"other" but has a name/)]);
  });

  it("shows the name, else the role, else a numbered speaker", () => {
    const speakers = [{ label: "S1", role: "host" as const, name: "Ben Thompson" }, { label: "S2", role: "guest" as const, name: null }, { label: "S3", role: "other" as const, name: null }];
    expect(["S1", "S2", "S3", "S4", null].map((l) => speakerDisplayName(l, speakers))).toEqual(["Ben Thompson", "Guest", "Speaker 3", "Speaker 4", "Speaker"]);
    expect(speakerDisplayName("S2", null)).toBe("Speaker 2");
  });
});
