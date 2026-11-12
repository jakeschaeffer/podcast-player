/**
 * Replays contracts/golden/speakers/speaker_names_v1.json (recorded by the server, whose speakerDisplayName is the
 * reference) against the web app's speakerName.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { speakerName, type Speaker } from "../src/api/transcripts";
import { GOLDEN_DIR } from "./golden";

type Case = { name: string; label: string | null; speakers: Speaker[] | null; expect: string | null };
const file = JSON.parse(readFileSync(join(GOLDEN_DIR, "speakers", "speaker_names_v1.json"), "utf8")) as { display_name: Case[] };

describe("speaker names (speaker_names_v1)", () => {
  it.each(file.display_name.map((c) => [c.name, c] as const))("%s", (_, c) => {
    expect(speakerName(c.label, c.speakers)).toBe(c.expect);
  });
});
