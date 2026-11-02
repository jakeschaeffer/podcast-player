import type { RawTranscript } from "../core/transcript/types.js";

/** What a transcription job hands to a provider adapter. */
export type TranscribeInput = {
  /** Absolute path of the stored audio asset. The bytes are uploaded; a feed URL is never sent to a provider. */
  path: string;
  /** Media type of the file, for example `audio/mpeg`. */
  mime: string;
  /** Measured duration from ffprobe; used for cost estimates and timing clamps. */
  duration_ms: number;
  /** ISO 639-1 or 639-3 language hint. Omit to auto-detect. */
  language?: string;
  /** Show-specific names and terms to bias recognition toward. Costs extra on some providers. */
  keyterms?: string[];
};

/**
 * The only interface the rest of the system knows about transcription.
 * Adapters map a provider's response into `RawTranscript`; `normalize()` does the rest.
 */
export interface Transcriber {
  readonly name: string;
  transcribe(input: TranscribeInput): Promise<RawTranscript>;
}
