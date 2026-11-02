/**
 * Transcribe one audio file with the configured provider and write eval fixtures.
 *
 *   pnpm transcribe <audio-file> [--language eng] [--keyterms "Name,Other name"] [--out <dir>]
 *                                [--model scribe_v2] [--cents-per-hour 22]
 *   pnpm transcribe --from-raw <file.elevenlabs.json> [--out <dir>]   # re-normalize a saved response, no API call
 *
 * Writes, in <out> (default: <repo>/evals/transcription/fixtures):
 *   <name>.elevenlabs.json   the provider's response, untouched, so normalization can be re-run for free
 *   <name>.transcript.json   the normalized transcript in the API shape, with provenance
 *
 * The API key comes from ELEVENLABS_API_KEY; the package script loads ../.env.local with --env-file.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { ElevenLabsTranscriber, ELEVENLABS_DEFAULT_CENTS_PER_HOUR, ELEVENLABS_DEFAULT_MODEL, mapElevenLabsResponse, type ElevenLabsResponseLike } from "../adapters/elevenlabs.js";
import { normalize, NORMALIZER_VERSION } from "../core/transcript/normalize.js";
import { toApiTranscript, type RawTranscript } from "../core/transcript/types.js";
import { probeAudio } from "../lib/ffprobe.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      language: { type: "string" },
      keyterms: { type: "string" },
      out: { type: "string" },
      model: { type: "string", default: ELEVENLABS_DEFAULT_MODEL },
      "cents-per-hour": { type: "string", default: String(ELEVENLABS_DEFAULT_CENTS_PER_HOUR) },
      "from-raw": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || (positionals.length === 0 && !values["from-raw"])) {
    console.log(usage());
    return values.help ? 0 : 2;
  }
  const outDir = resolve(values.out ?? resolve(REPO_ROOT, "evals/transcription/fixtures"));
  await mkdir(outDir, { recursive: true });
  const centsPerHour = Number(values["cents-per-hour"]);
  const keyterms = values.keyterms ? values.keyterms.split(",").map((s) => s.trim()).filter(Boolean) : [];

  let raw: RawTranscript;
  let name: string;
  let source: Record<string, unknown>;
  const started = Date.now();

  if (values["from-raw"]) {
    const rawPath = resolve(values["from-raw"]);
    const saved = JSON.parse(await readFile(rawPath, "utf8")) as { response: ElevenLabsResponseLike; input?: { duration_ms?: number; model?: string; keyterms?: string[] } };
    const response = saved.response ?? (saved as unknown as ElevenLabsResponseLike);
    raw = mapElevenLabsResponse(response, {
      model: saved.input?.model ?? values.model!,
      fallback_duration_ms: saved.input?.duration_ms ?? 0,
      cents_per_hour: centsPerHour,
      keyterms_used: (saved.input?.keyterms?.length ?? 0) > 0,
    });
    name = basename(rawPath).replace(/\.elevenlabs\.json$/, "");
    source = { from_raw: rawPath };
  } else {
    const audioPath = resolve(positionals[0]!);
    if (!process.env.ELEVENLABS_API_KEY) {
      console.error("ELEVENLABS_API_KEY is not set. Put it in .env.local at the repo root; `pnpm transcribe` loads that file.");
      return 2;
    }
    const probe = await probeAudio(audioPath);
    console.error(`probe: ${(probe.duration_ms / 1000).toFixed(1)} s, ${probe.mime}, ${probe.codec}, ${(probe.bytes / 1e6).toFixed(1)} MB`);

    // Keep the untouched provider response so normalization can be iterated on without paying again.
    const client = new ElevenLabsClient();
    const transcriber = new ElevenLabsTranscriber({ client, model: values.model!, centsPerHour });
    const captured = captureResponse(client);
    raw = await transcriber.transcribe({
      path: audioPath,
      mime: probe.mime,
      duration_ms: probe.duration_ms,
      ...(values.language ? { language: values.language } : {}),
      ...(keyterms.length > 0 ? { keyterms } : {}),
    });
    name = basename(audioPath, extname(audioPath));
    source = { audio_path: audioPath, probe };
    const rawOut = resolve(outDir, `${name}.elevenlabs.json`);
    await writeFile(
      rawOut,
      JSON.stringify({ input: { model: values.model, language: values.language ?? null, keyterms, duration_ms: probe.duration_ms }, response: captured.response }, null, 1),
    );
    console.error(`wrote ${rawOut}`);
  }

  const normalized = normalize(raw, raw.duration_ms !== undefined ? { duration_ms: raw.duration_ms } : {});
  const api = toApiTranscript(normalized);
  const elapsed_ms = Date.now() - started;
  const transcriptOut = resolve(outDir, `${name}.transcript.json`);
  await writeFile(
    transcriptOut,
    JSON.stringify(
      {
        ...api,
        provenance: {
          provider: raw.provider,
          model: raw.model,
          normalizer: NORMALIZER_VERSION,
          provider_request_id: raw.provider_request_id ?? null,
          duration_ms: raw.duration_ms ?? null,
          cost_cents: raw.cost_cents ?? null,
          elapsed_ms,
          created_at: new Date().toISOString(),
          ...source,
        },
      },
      null,
      1,
    ),
  );
  console.error(`wrote ${transcriptOut}`);

  const speakers = new Set(normalized.segments.map((s) => s.speaker).filter((s): s is string => s !== null));
  const lastEnd = normalized.segments.at(-1)?.end_ms ?? 0;
  console.log(
    [
      `language      ${normalized.language ?? "?"}`,
      `duration      ${((raw.duration_ms ?? lastEnd) / 1000).toFixed(1)} s`,
      `words         ${normalized.word_count}`,
      `segments      ${normalized.segments.length}`,
      `speakers      ${speakers.size}`,
      `events        ${normalized.events.length}${normalized.events.length ? " (" + [...new Set(normalized.events.map((e) => e[2]))].slice(0, 6).join(", ") + ")" : ""}`,
      `est. cost     ${raw.cost_cents ?? "?"} cents`,
      `elapsed       ${(elapsed_ms / 1000).toFixed(1)} s`,
    ].join("\n"),
  );
  const first = normalized.segments[0];
  if (first) console.log(`\n[${first.speaker ?? "-"}] ${first.text.slice(0, 200)}${first.text.length > 200 ? "…" : ""}`);
  return 0;
}

/** Wrap the SDK's fetcher so the CLI can save the exact JSON the provider returned. */
function captureResponse(client: ElevenLabsClient): { response: unknown } {
  const holder: { response: unknown } = { response: null };
  const original = client.speechToText.convert.bind(client.speechToText);
  client.speechToText.convert = ((...args: Parameters<typeof original>) => {
    const promise = original(...args);
    promise.then((data) => { holder.response = data; }, () => undefined);
    return promise;
  }) as typeof original;
  return holder;
}

function usage(): string {
  return `usage:
  pnpm transcribe <audio-file> [--language eng] [--keyterms "A,B"] [--out <dir>] [--model scribe_v2] [--cents-per-hour 22]
  pnpm transcribe --from-raw <name.elevenlabs.json> [--out <dir>]

Default output directory: evals/transcription/fixtures (gitignored).`;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  },
);
