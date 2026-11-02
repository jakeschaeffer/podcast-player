import { basename } from "node:path";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type { RawEvent, RawTranscript, RawWord } from "../core/transcript/types.js";
import type { TranscribeInput, Transcriber } from "./transcriber.js";

export const ELEVENLABS_DEFAULT_MODEL = "scribe_v2";

/** Listed API rate for Scribe v2 on paid plans, October 2026. Override per deployment. */
export const ELEVENLABS_DEFAULT_CENTS_PER_HOUR = 22;

/** Keyterm prompting carries a 20% surcharge. */
const KEYTERM_SURCHARGE = 1.2;

export type ElevenLabsTranscriberOptions = {
  /** Defaults to `ELEVENLABS_API_KEY` from the environment, which the SDK reads itself. */
  apiKey?: string;
  model?: string;
  centsPerHour?: number;
  /** Upload plus transcription of a multi-hour file can take minutes. */
  timeoutSeconds?: number;
  maxRetries?: number;
  /** Injected in tests. */
  client?: ElevenLabsClient;
};

/**
 * ElevenLabs Scribe adapter: one multipart request per asset, word timestamps, diarization,
 * and audio-event tags on. Files up to 10 hours go in a single request, so there is no chunking.
 */
export class ElevenLabsTranscriber implements Transcriber {
  readonly name = "elevenlabs";
  private readonly client: ElevenLabsClient;
  private readonly model: string;
  private readonly centsPerHour: number;
  private readonly timeoutSeconds: number;
  private readonly maxRetries: number;

  constructor(options: ElevenLabsTranscriberOptions = {}) {
    this.client = options.client ?? new ElevenLabsClient(options.apiKey ? { apiKey: options.apiKey } : {});
    this.model = options.model ?? ELEVENLABS_DEFAULT_MODEL;
    this.centsPerHour = options.centsPerHour ?? ELEVENLABS_DEFAULT_CENTS_PER_HOUR;
    this.timeoutSeconds = options.timeoutSeconds ?? 15 * 60;
    this.maxRetries = options.maxRetries ?? 3;
  }

  async transcribe(input: TranscribeInput): Promise<RawTranscript> {
    const keyterms = input.keyterms?.filter((k) => k.trim().length > 0) ?? [];
    const { data, rawResponse } = await this.client.speechToText
      .convert(
        {
          file: { path: input.path, filename: basename(input.path), contentType: input.mime },
          modelId: this.model,
          timestampsGranularity: "word",
          diarize: true,
          tagAudioEvents: true,
          ...(input.language ? { languageCode: input.language } : {}),
          ...(keyterms.length > 0 ? { keyterms } : {}),
        },
        { timeoutInSeconds: this.timeoutSeconds, maxRetries: this.maxRetries },
      )
      .withRawResponse();

    const requestId = rawResponse.headers.get("request-id") ?? undefined;
    return mapElevenLabsResponse(data, {
      model: this.model,
      fallback_duration_ms: input.duration_ms,
      cents_per_hour: this.centsPerHour,
      keyterms_used: keyterms.length > 0,
      ...(requestId ? { request_id: requestId } : {}),
    });
  }
}

/** The subset of the SDK's response this adapter reads. Kept structural so a saved JSON response maps the same way. */
export type ElevenLabsResponseLike = {
  languageCode?: string;
  languageProbability?: number;
  text?: string;
  words?: {
    text: string;
    start?: number;
    end?: number;
    type: "word" | "spacing" | "audio_event" | string;
    speakerId?: string;
    logprob?: number;
  }[];
  audioDurationSecs?: number;
  transcriptionId?: string;
  transcripts?: unknown[];
};

export type MapContext = {
  model: string;
  fallback_duration_ms: number;
  cents_per_hour: number;
  keyterms_used: boolean;
  request_id?: string;
};

/**
 * Map an ElevenLabs speech-to-text response to `RawTranscript`.
 * Pure, so it is unit-tested against a saved response and reused by the CLI's `--from-raw` path.
 */
export function mapElevenLabsResponse(res: ElevenLabsResponseLike, ctx: MapContext): RawTranscript {
  if (Array.isArray(res.transcripts)) {
    throw new Error("elevenlabs: multichannel response not supported; request a single combined transcript");
  }
  if (!Array.isArray(res.words)) {
    if (res.transcriptionId) {
      throw new Error(`elevenlabs: response ${res.transcriptionId} has no words (webhook mode?); synchronous mode is required`);
    }
    throw new Error("elevenlabs: response has no words array");
  }

  const words: RawWord[] = [];
  const events: RawEvent[] = [];
  for (const w of res.words) {
    if (w.type === "spacing") continue;
    if (typeof w.start !== "number" || typeof w.end !== "number") continue;
    const start_ms = Math.round(w.start * 1000);
    const end_ms = Math.round(w.end * 1000);
    if (w.type === "audio_event") {
      events.push({ label: eventLabel(w.text), start_ms, end_ms });
      continue;
    }
    const word: RawWord = { text: w.text, start_ms, end_ms };
    if (w.speakerId) word.speaker = w.speakerId;
    if (typeof w.logprob === "number" && Number.isFinite(w.logprob)) word.confidence = Math.min(1, Math.exp(w.logprob));
    words.push(word);
  }

  const duration_ms =
    typeof res.audioDurationSecs === "number" ? Math.round(res.audioDurationSecs * 1000) : ctx.fallback_duration_ms;
  const hours = duration_ms / 3_600_000;
  const cost_cents = Math.ceil(hours * ctx.cents_per_hour * (ctx.keyterms_used ? KEYTERM_SURCHARGE : 1));

  const out: RawTranscript = {
    provider: "elevenlabs",
    model: ctx.model,
    language: res.languageCode ?? null,
    words,
    events,
    duration_ms,
    cost_cents,
  };
  const requestId = res.transcriptionId ?? ctx.request_id;
  if (requestId) out.provider_request_id = requestId;
  return out;
}

/** `(laughter)` → `laughter`, `[MUSIC]` → `music`. */
function eventLabel(text: string): string {
  const stripped = text.trim().replace(/^[\[(]+|[\])]+$/g, "").trim().toLowerCase();
  return stripped.length > 0 ? stripped : "event";
}
