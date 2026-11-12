/**
 * The recipient side of a snip: what `/s/{token}` may show and serve. Everything is built from a typed
 * struct over the current, ready revision of an active snip; nothing else is ever serialized.
 */
import type { AppContext } from "../app/context.js";
import { posterPath } from "../core/clip/render.js";
import type { SnipRow } from "../db/rows.js";
import { SHARE_TOKEN_RE } from "../lib/ids.js";
import { clipTurns, type NamedTurn } from "../core/speakers/identify.js";
import { speakerTurns } from "../core/transcript/normalize.js";
import { speakersFor } from "./speakers.js";
import { episodeForAsset, getRevisionRow } from "./snips.js";
import { loadTranscript } from "./transcripts.js";

/** One voice's turn in a shared excerpt, with the heading shown for it (the person, "Host", "Speaker 2"), or none. */
export type PublicTurn = NamedTurn;

export type PublicSnip =
  | {
      kind: "ready"; token: string; rev: number; title: string; summary: string | null; quote: string | null; excerpt: string | null;
      /** The excerpt split by voice, when it has more than one heading (core/speakers/identify.ts clipTurns); otherwise null and the excerpt reads as one block. */
      turns: PublicTurn[] | null;
      duration_ms: number; clip_url: string;
      /** The clip with its picture, when the snip was cut from a video and that has been rendered; else it is audio only. */
      video: { url: string; poster_url: string; width: number; height: number } | null;
      created_at: number; episode: { title: string; public_url: string | null }; show: { title: string | null; site_url: string | null };
    }
  | { kind: "preparing"; token: string }
  | { kind: "gone" }
  | { kind: "not_found" };

/** Everything a recipient may see, built from a typed struct rather than the rows. */
export function publicSnip(ctx: AppContext, token: string): PublicSnip {
  if (!SHARE_TOKEN_RE.test(token)) return { kind: "not_found" };
  const snip = ctx.db.prepare("SELECT * FROM snip WHERE share_token = ?").get(token) as SnipRow | undefined;
  if (!snip) return { kind: "not_found" };
  if (snip.deleted_at !== null || snip.share_state !== "active") return { kind: "gone" };
  const rev = snip.current_revision_id ? getRevisionRow(ctx, snip.current_revision_id) : null;
  if (!rev || rev.status !== "ready" || !rev.clip_path) return { kind: "preparing", token };
  const { episode, feed } = episodeForAsset(ctx, snip.audio_asset_id);
  const isPublic = feed.is_private === 0;
  return {
    kind: "ready",
    token,
    rev: rev.rev,
    title: rev.title ?? fallbackFromExcerpt(rev.excerpt),
    summary: rev.summary,
    quote: rev.quote,
    excerpt: rev.excerpt,
    turns: turnsFor(ctx, rev.transcript_id, rev.start_word, rev.end_word),
    duration_ms: rev.clip_duration_ms ?? rev.end_ms - rev.start_ms,
    clip_url: `${ctx.config.publicBaseUrl}/s/${token}/r${rev.rev}.mp3`,
    video: rev.video_clip_path
      ? { url: `${ctx.config.publicBaseUrl}/s/${token}/r${rev.rev}.mp4`, poster_url: `${ctx.config.publicBaseUrl}/s/${token}/r${rev.rev}.jpg`, width: rev.video_clip_width ?? 0, height: rev.video_clip_height ?? 0 }
      : null,
    created_at: snip.created_at,
    episode: { title: episode.title, public_url: isPublic ? episode.link : null },
    show: { title: feed.title, site_url: isPublic ? feed.site_url : null },
  };
}

/** A public file of a snip: its clip, the clip with its picture, or that picture's poster. */
export type PublicClipFile = "mp3" | "mp4" | "jpg";

/** The file for `/s/{token}/r{rev}.{mp3,mp4,jpg}`, only when that revision is the current, ready one of an active snip. */
export function publicClip(ctx: AppContext, token: string, rev: number, file: PublicClipFile = "mp3"): { path: string; sha256: string } | "preparing" | "gone" | "not_found" {
  const view = publicSnip(ctx, token);
  if (view.kind !== "ready") return view.kind;
  if (view.rev !== rev) return "not_found";
  const snip = ctx.db.prepare("SELECT current_revision_id FROM snip WHERE share_token = ?").get(token) as { current_revision_id: string };
  const r = getRevisionRow(ctx, snip.current_revision_id);
  if (file === "mp3") return { path: r.clip_path!, sha256: r.clip_sha256 ?? r.id };
  if (!r.video_clip_path) return "not_found";
  return file === "mp4" ? { path: r.video_clip_path, sha256: r.video_clip_sha256 ?? r.id } : { path: posterPath(r.video_clip_path), sha256: `${r.video_clip_sha256 ?? r.id}-poster` };
}

/** Who said what in the excerpt, read against the transcript the revision was cut from. */
function turnsFor(ctx: AppContext, transcriptId: string | null, start: number | null, end: number | null): PublicTurn[] | null {
  if (!transcriptId || start === null || end === null) return null;
  return clipTurns(speakerTurns(loadTranscript(ctx, transcriptId), start, end), speakersFor(ctx, transcriptId));
}

function fallbackFromExcerpt(excerpt: string | null): string {
  if (!excerpt) return "Snip";
  const words = excerpt.split(/\s+/).filter(Boolean);
  return words.length > 8 ? `${words.slice(0, 8).join(" ")}…` : words.join(" ");
}
