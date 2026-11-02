/**
 * Transcript types shared by every transcription provider and every consumer.
 *
 * Conventions (see docs/core/README.md):
 * - All `*_ms` values are integer milliseconds from the start of one audio asset.
 * - Words are the coordinate system: after normalization every word has a global
 *   index `0..word_count-1` that never changes for the life of the transcript.
 */

/** A spoken word as a provider returned it, already converted to milliseconds. */
export type RawWord = {
  text: string;
  start_ms: number;
  end_ms: number;
  /** Provider speaker label (for example `speaker_0`). Relabelled to S1, S2… by the normalizer. */
  speaker?: string;
  /** 0..1 when the provider exposes one. */
  confidence?: number;
};

/** A non-speech sound the provider tagged, such as music or laughter. */
export type RawEvent = {
  label: string;
  start_ms: number;
  end_ms: number;
};

/** Provider output after the adapter mapped it, before normalization. */
export type RawTranscript = {
  provider: string;
  model: string;
  /** ISO 639 code as reported, or null when unknown. */
  language: string | null;
  words: RawWord[];
  events: RawEvent[];
  /** Audio duration as the provider measured it, if reported. */
  duration_ms?: number;
  /** Estimated cost from the configured rate, if known. */
  cost_cents?: number;
  /** Provider-side identifier for the request, for support and the usage ledger. */
  provider_request_id?: string;
};

/** `[start_ms, end_ms, text]`, the compact word form stored and served. */
export type WordTuple = [number, number, string];

/** `[start_ms, end_ms, label]`. */
export type EventTuple = [number, number, string];

/** One stored transcript segment: a run of words by one speaker, split at long pauses and capped in length. */
export type Segment = {
  idx: number;
  start_ms: number;
  end_ms: number;
  /** `S1`, `S2`… by order of first appearance, or null when the provider gave no speakers. */
  speaker: string | null;
  /** Global index of the first word in this segment. */
  first_word: number;
  /** Words joined with single spaces; what full-text search indexes. */
  text: string;
  words: WordTuple[];
};

/** The normalized, immutable transcript. */
export type NormalizedTranscript = {
  provider: string;
  model: string;
  language: string | null;
  word_count: number;
  segments: Segment[];
  events: EventTuple[];
};

/** The shape `GET /v1/transcripts/{id}` serves (docs/core/data-model.md). */
export type ApiTranscript = {
  id?: string;
  asset_id?: string;
  language: string | null;
  word_count: number;
  segments: { s: number; e: number; spk: string | null; w0: number; words: WordTuple[] }[];
  events: EventTuple[];
};

export function toApiTranscript(t: NormalizedTranscript, ids?: { id: string; asset_id: string }): ApiTranscript {
  return {
    ...(ids ?? {}),
    language: t.language,
    word_count: t.word_count,
    segments: t.segments.map((s) => ({ s: s.start_ms, e: s.end_ms, spk: s.speaker, w0: s.first_word, words: s.words })),
    events: t.events,
  };
}
