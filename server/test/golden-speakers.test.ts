/**
 * Golden cases for how a transcript's speaker labels are shown: the heading for one label (speakerDisplayName) and a
 * clip's turns on the snip pages (clipTurns). Labels come from speech recognition ("S1"), from publisher text (names,
 * initials, "Host", "Quote"), or not at all; the web app and the native app replay these cases.
 */
import { describe, expect, it } from "vitest";
import { clipTurns, speakerDisplayName, type SpeakerIdentity } from "../src/core/speakers/identify.js";
import { golden } from "./helpers/golden.js";

const identified: SpeakerIdentity[] = [
  { label: "S1", role: "host", name: "Ben Thompson" },
  { label: "S2", role: "guest", name: null },
  { label: "S3", role: "other", name: null },
  { label: "Host", role: "host", name: "Ben Thompson" },
];

const labels: [string, string | null, SpeakerIdentity[] | null][] = [
  ["recognized speaker with a name", "S1", identified],
  ["recognized guest without a name", "S2", identified],
  ["recognized other voice", "S3", identified],
  ["recognized speaker not in the list", "S4", identified],
  ["recognized speaker before identification", "S2", null],
  ["two-digit recognized label", "S12", null],
  ["publisher's name", "Ari Emanuel", null],
  ["publisher's initials", "PA", null],
  ["publisher's Host, not identified", "Host", null],
  ["publisher's Host, identified", "Host", identified],
  ["a label that only starts with S", "Sam", null],
  ["quoted passage", "Quote", identified],
  ["no label", null, identified],
  ["empty label", "", null],
];
const display = labels.map(([name, label, speakers]) => ({ name, label, speakers, expect: speakerDisplayName(label, speakers) }));

type In = { speaker: string | null; text: string };
const clips: [string, In[], SpeakerIdentity[] | null][] = [
  ["one recognized speaker", [{ speaker: "S1", text: "Just me today." }], identified],
  ["two recognized speakers", [{ speaker: "S1", text: "Why?" }, { speaker: "S2", text: "Because." }, { speaker: "S1", text: "Fair." }], identified],
  ["no labels at all", [{ speaker: null, text: "Captions have no speakers." }], null],
  ["an article quoting a passage", [{ speaker: "Quote", text: "I'm delighted to invest." }, { speaker: null, text: "Anthropic needs Nvidia the least." }], null],
  ["an article, quote in the middle", [{ speaker: null, text: "He said:" }, { speaker: "Quote", text: "We will win." }, { speaker: null, text: "I doubt it." }], null],
  ["an interview from publisher text", [{ speaker: "Host", text: "Why buy it?" }, { speaker: "Ari Emanuel", text: "Because it was cheap." }], null],
  ["an interview with the host identified", [{ speaker: "Host", text: "Why buy it?" }, { speaker: "Ari Emanuel", text: "Because it was cheap." }], identified],
  ["the host's prose then a guest", [{ speaker: null, text: "I asked him about it." }, { speaker: "Horace Dediu", text: "It is a moat." }], null],
  ["one publisher name alone", [{ speaker: "Horace Dediu", text: "It is a moat." }], null],
  ["two labels with the same name run together", [{ speaker: "S1", text: "Hello." }, { speaker: "Host", text: "Again." }, { speaker: "S2", text: "Hi." }], identified],
];
const turns = clips.map(([name, input, speakers]) => ({ name, turns: input, speakers, expect: clipTurns(input, speakers) }));

describe("speaker name golden cases", () => {
  it("behave as intended", () => {
    const by = Object.fromEntries(display.map((d) => [d.name, d.expect]));
    expect(by["recognized speaker with a name"]).toBe("Ben Thompson");
    expect(by["recognized speaker before identification"]).toBe("Speaker 2");
    expect(by["publisher's name"]).toBe("Ari Emanuel");
    expect(by["publisher's Host, not identified"]).toBe("Host");
    expect(by["a label that only starts with S"]).toBe("Sam");
    expect(by["quoted passage"]).toBeNull();
    expect(by["no label"]).toBeNull();
    const clip = Object.fromEntries(turns.map((t) => [t.name, t.expect]));
    expect(clip["one recognized speaker"]).toBeNull();
    expect(clip["an article quoting a passage"]).toBeNull();
    expect(clip["an article, quote in the middle"]).toBeNull();
    expect(clip["an interview from publisher text"]?.map((t) => t.name)).toEqual(["Host", "Ari Emanuel"]);
    expect(clip["the host's prose then a guest"]?.map((t) => t.name)).toEqual([null, "Horace Dediu"]);
    expect(clip["two labels with the same name run together"]?.map((t) => [t.name, t.text])).toEqual([["Ben Thompson", "Hello. Again."], ["Guest", "Hi."]]);
  });

  it("match the committed file", () => {
    const file = {
      family: "speakers",
      version: "speaker_names_v1",
      reference: ["server/src/core/speakers/identify.ts"],
      display_name: display,
      clip_turns: turns,
    };
    expect(golden("speakers/speaker_names_v1.json", file)).toEqual(JSON.parse(JSON.stringify(file)));
  });
});
