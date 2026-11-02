import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { mapElevenLabsResponse, type ElevenLabsResponseLike } from "./elevenlabs.js";

const ctx = { model: "scribe_v2", fallback_duration_ms: 12_400, cents_per_hour: 22, keyterms_used: false };

async function fixture(): Promise<ElevenLabsResponseLike> {
  return JSON.parse(await readFile(new URL("../../test/fixtures/elevenlabs-response.json", import.meta.url), "utf8"));
}

describe("mapElevenLabsResponse", () => {
  it("keeps words, drops spacing, and lifts audio events out", async () => {
    const raw = mapElevenLabsResponse(await fixture(), ctx);
    expect(raw.provider).toBe("elevenlabs");
    expect(raw.model).toBe("scribe_v2");
    expect(raw.language).toBe("eng");
    expect(raw.words.map((w) => w.text)).toEqual([
      "So", "the", "thing", "is,", "we", "never", "tested", "demand.",
      "Right.", "Why", "not?",
      "Because", "the", "first", "approach", "failed", "quietly.",
    ]);
    expect(raw.events).toEqual([
      { label: "music", start_ms: 0, end_ms: 1800 },
      { label: "laughter", start_ms: 9300, end_ms: 10_100 },
    ]);
  });

  it("converts seconds to integer milliseconds and keeps provider speaker ids", async () => {
    const raw = mapElevenLabsResponse(await fixture(), ctx);
    expect(raw.words[0]).toMatchObject({ text: "So", start_ms: 2000, end_ms: 2200, speaker: "speaker_0" });
    expect(raw.words[8]).toMatchObject({ text: "Right.", start_ms: 5200, end_ms: 5500, speaker: "speaker_1" });
    for (const w of raw.words) {
      expect(Number.isInteger(w.start_ms)).toBe(true);
      expect(Number.isInteger(w.end_ms)).toBe(true);
    }
  });

  it("maps logprob to a confidence in 0..1", async () => {
    const raw = mapElevenLabsResponse(await fixture(), ctx);
    expect(raw.words[8]!.confidence).toBeCloseTo(Math.exp(-0.3), 6);
    expect(raw.words.every((w) => w.confidence !== undefined && w.confidence > 0 && w.confidence <= 1)).toBe(true);
  });

  it("uses the provider's measured duration for cost and records the transcription id", async () => {
    const raw = mapElevenLabsResponse(await fixture(), ctx);
    expect(raw.duration_ms).toBe(12_400);
    expect(raw.cost_cents).toBe(1); // ceil(12.4 s / 3600 s × 22 ¢)
    expect(raw.provider_request_id).toBe("tx_fixture_001");
  });

  it("applies the keyterm surcharge and falls back to the probed duration", () => {
    const res: ElevenLabsResponseLike = { languageCode: "eng", words: [] };
    const oneHour = mapElevenLabsResponse(res, { ...ctx, fallback_duration_ms: 3_600_000 });
    expect(oneHour.cost_cents).toBe(22);
    const withKeyterms = mapElevenLabsResponse(res, { ...ctx, fallback_duration_ms: 3_600_000, keyterms_used: true });
    expect(withKeyterms.cost_cents).toBe(27); // ceil(22 × 1.2)
  });

  it("rejects webhook and multichannel responses", () => {
    expect(() => mapElevenLabsResponse({ transcriptionId: "tx_1" }, ctx)).toThrow(/webhook/);
    expect(() => mapElevenLabsResponse({ transcripts: [] }, ctx)).toThrow(/multichannel/);
  });
});
