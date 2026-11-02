import { describe, expect, it } from "vitest";
import { buildTranscript } from "../../../test/helpers/transcript.js";
import { sentencize } from "./sentencize.js";

describe("sentencize", () => {
  const t = buildTranscript([
    { speaker: "host", text: "So the thing is, we never tested demand. It took a year to notice." },
    { speaker: "guest", text: "Right.", pause_ms: 200 },
    { speaker: "host", text: "Why not? Because the first approach failed quietly. Yeah." },
    { speaker: "host", text: "After a long pause we tried again.", pause_ms: 3000 },
  ]);

  it("splits on sentence punctuation and speaker changes", () => {
    const s = sentencize(t);
    expect(s.map((x) => [x.speaker, x.text])).toEqual([
      ["S1", "So the thing is, we never tested demand."],
      ["S1", "It took a year to notice."],
      ["S2", "Right."],
      ["S1", "Why not?"],
      ["S1", "Because the first approach failed quietly. Yeah."],
      ["S1", "After a long pause we tried again."],
    ]);
  });

  it("merges short same-speaker fragments but keeps another speaker's interjection", () => {
    const s = sentencize(t);
    expect(s.find((x) => x.text === "Right.")).toBeDefined();
    expect(s.find((x) => x.text === "Yeah.")).toBeUndefined();
  });

  it("keeps ids sequential and word ranges contiguous", () => {
    const s = sentencize(t);
    s.forEach((x, i) => expect(x.id).toBe(i));
    for (let i = 1; i < s.length; i++) expect(s[i]!.start_word).toBe(s[i - 1]!.end_word);
    expect(s[0]!.start_word).toBe(0);
    expect(s.at(-1)!.end_word).toBe(t.word_count);
  });

  it("restricts to a time range by word overlap", () => {
    const all = sentencize(t);
    const third = all[2]!;
    const sub = sentencize(t, { from_ms: third.start_ms, to_ms: third.end_ms + 1 });
    expect(sub).toHaveLength(1);
    expect(sub[0]!.text).toBe("Right.");
    expect(sub[0]!.start_word).toBe(third.start_word);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(sentencize(t))).toBe(JSON.stringify(sentencize(t)));
  });
});
