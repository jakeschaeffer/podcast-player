import { basename } from "node:path";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

export type AlignedWord = { text: string; start_ms: number; end_ms: number; loss: number };
export type ForcedAlignmentResult = { words: AlignedWord[]; loss: number; cost_cents: number; elapsed_ms: number };

/** Known text plus stored audio in, word timings out. */
export interface ForcedAligner {
  readonly name: string;
  align(input: { path: string; mime: string; duration_ms: number; text: string }): Promise<ForcedAlignmentResult>;
}

/** Listed rate: forced alignment is billed like speech to text. */
export const FORCED_ALIGNMENT_CENTS_PER_HOUR = 22;

/**
 * ElevenLabs forced alignment: known text plus our stored audio in, word timings out.
 * The text is a plain string; the response words follow the input's whitespace tokens in order.
 */
export class ElevenLabsForcedAligner implements ForcedAligner {
  readonly name = "elevenlabs";
  private readonly client: ElevenLabsClient;
  constructor(private readonly options: { apiKey?: string; centsPerHour?: number; timeoutSeconds?: number; client?: ElevenLabsClient } = {}) {
    this.client = options.client ?? new ElevenLabsClient(options.apiKey ? { apiKey: options.apiKey } : {});
  }

  async align(input: { path: string; mime: string; duration_ms: number; text: string }): Promise<ForcedAlignmentResult> {
    if (input.text.length > 675_000) throw new Error(`forced alignment: text is ${input.text.length} characters; the limit is 675,000`);
    const started = Date.now();
    const res = await this.client.forcedAlignment.create(
      { file: { path: input.path, filename: basename(input.path), contentType: input.mime }, text: input.text },
      { timeoutInSeconds: this.options.timeoutSeconds ?? 15 * 60, maxRetries: 2 },
    );
    const words: AlignedWord[] = res.words
      .filter((w) => w.text.trim().length > 0)
      .map((w) => ({ text: w.text, start_ms: Math.round(w.start * 1000), end_ms: Math.round(w.end * 1000), loss: w.loss }));
    const cost_cents = Math.ceil((input.duration_ms / 3_600_000) * (this.options.centsPerHour ?? FORCED_ALIGNMENT_CENTS_PER_HOUR));
    return { words, loss: res.loss, cost_cents, elapsed_ms: Date.now() - started };
  }
}
