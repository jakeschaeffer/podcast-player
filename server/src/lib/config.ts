import { resolve } from "node:path";

export type TextModelKind = "none" | "codex-cli";

export type Config = {
  /** Directory holding app.db and media/. */
  dataDir: string;
  host: string;
  port: number;
  /** Derives the encryption and signing keys. */
  appSecret: string;
  /** Password that mints device tokens through POST /v1/devices. */
  ownerPassword: string;
  /** Origin used to build share and media URLs, e.g. https://pods.example.com. */
  publicBaseUrl: string;
  /** Who the public share pages say the clips are from, on their preview images ("10 clips from Jake"). */
  shareByName: string;
  /** How much video the server keeps at most; the least recently played goes first (services/video.ts). */
  videoStoreMaxBytes: number;
  /** A video the server fetches itself is scaled down to this many pixels on its shorter side when taller; 0 keeps it as it is. */
  videoMaxHeight: number;
  /** IANA timezone for the daily refresh window. */
  timezone: string;
  elevenLabsApiKey: string | null;
  transcriptionCentsPerHour: number;
  /** Which TextModel adapter serves summaries and model-assisted selection; 'none' uses heuristics and leaves summaries pending. */
  textModel: TextModelKind;
  /** Codex CLI model name, when textModel is codex-cli. Empty uses the CLI default. */
  codexModel: string;
  /** Codex reasoning effort (low, medium, high). Empty uses the CLI default. */
  codexReasoningEffort: string;
  /** Whether the text model may adjust snip starts. Off by default: it scored below the deterministic snap on the owner's snips. */
  selectionModel: boolean;
  /** Gmail search for publisher newsletters that carry episode text. Empty disables the email source (text feeds are the default path). */
  emailSourceQuery: string;
  /** Episode kinds for which a transcript aligned from publisher text becomes the current transcript (ASR stays current for the rest). */
  textPreferredKinds: Set<string>;
  mediaUrlTtlSeconds: number;
  /** Monthly cap for priority-0 (catalog) transcription; owner-triggered work is never capped. */
  transcriptionBudgetMinutes: number;
  /** Tests only: let feed and enclosure fetches reach loopback addresses. Never set in production. */
  allowPrivateNetwork: boolean;
  /** The worker refreshes every feed this often so new releases are fetched and transcribed without cron. 0 disables. */
  refreshIntervalMinutes: number;
  /** Push the server's own commits (prompt versions, eval scorecards) to origin right after making them. Production only. */
  gitAutoPush: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const appSecret = env.APP_SECRET ?? "";
  const ownerPassword = env.OWNER_PASSWORD ?? "";
  if (!appSecret) throw new Error("APP_SECRET is required (any long random string)");
  if (!ownerPassword) throw new Error("OWNER_PASSWORD is required");
  const port = Number(env.PORT ?? 8080);
  const textModel = (env.TEXT_MODEL ?? "none") as TextModelKind;
  if (textModel !== "none" && textModel !== "codex-cli") throw new Error(`TEXT_MODEL must be none or codex-cli, got ${textModel}`);
  return {
    dataDir: resolve(env.DATA_DIR ?? "./data"),
    host: env.HOST ?? "127.0.0.1",
    port,
    appSecret,
    ownerPassword,
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, ""),
    shareByName: env.SHARE_BY_NAME ?? "",
    videoStoreMaxBytes: Number(env.VIDEO_STORE_MAX_BYTES ?? 4 * 1024 ** 3),
    videoMaxHeight: Number(env.VIDEO_MAX_HEIGHT ?? 480),
    timezone: env.TIMEZONE ?? "UTC",
    elevenLabsApiKey: env.ELEVENLABS_API_KEY ?? null,
    transcriptionCentsPerHour: Number(env.TRANSCRIPTION_CENTS_PER_HOUR ?? 22),
    textModel,
    codexModel: env.CODEX_MODEL ?? "",
    codexReasoningEffort: env.CODEX_REASONING_EFFORT ?? "",
    selectionModel: env.SELECTION_MODEL === "on",
    emailSourceQuery: env.EMAIL_SOURCE_QUERY ?? "",
    textPreferredKinds: new Set((env.TEXT_PREFERRED_KINDS ?? "update,article").split(",").map((k) => k.trim()).filter(Boolean)),
    mediaUrlTtlSeconds: Number(env.MEDIA_URL_TTL_SECONDS ?? 86_400),
    transcriptionBudgetMinutes: Number(env.TRANSCRIPTION_BUDGET_MINUTES ?? 6000),
    allowPrivateNetwork: env.ALLOW_PRIVATE_NETWORK === "1",
    refreshIntervalMinutes: Number(env.REFRESH_INTERVAL_MINUTES ?? 30),
    gitAutoPush: env.GIT_AUTO_PUSH === "1",
  };
}
