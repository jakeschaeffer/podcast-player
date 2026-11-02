/**
 * Episode share pages: one public link per episode, made only when the owner shares it, that lists every snip of
 * that episode a recipient could already open on its own (active, current revision ready) in episode order. The list
 * is read when the page is opened, so later snips appear and revoked or deleted ones drop off without a new link.
 * Each item is built from the same whitelisted public view as `/s/{token}`, plus its position in the episode.
 */
import type { AppContext } from "../app/context.js";
import { notFound } from "../app/errors.js";
import { newId, newShareToken, SHARE_TOKEN_RE } from "../lib/ids.js";
import { getEpisodeRow } from "./episodes.js";
import { publicSnip, type PublicTurn } from "./publicSnips.js";

type EpisodeShareRow = { id: string; episode_id: string; share_token: string; share_state: "active" | "revoked"; created_at: number; revoked_at: number | null };

export type EpisodeShareView = { share_url: string; state: "active" | "revoked"; snip_count: number; created_at: number };

export type PublicEpisodeSnip = {
  token: string; rev: number; title: string; summary: string | null; quote: string | null; excerpt: string | null; turns: PublicTurn[] | null;
  duration_ms: number; start_ms: number; page_path: string; clip_path: string;
  video: { path: string; poster_path: string; width: number; height: number } | null;
};
export type PublicEpisode =
  | { kind: "ready"; token: string; episode: { title: string; public_url: string | null }; show: { title: string | null; site_url: string | null }; snips: PublicEpisodeSnip[] }
  | { kind: "gone" }
  | { kind: "not_found" };

export function episodeShareUrl(ctx: AppContext, token: string): string {
  return `${ctx.config.publicBaseUrl}/e/${token}`;
}

function shareRow(ctx: AppContext, episodeId: string): EpisodeShareRow | undefined {
  return ctx.db.prepare("SELECT * FROM episode_share WHERE episode_id = ?").get(episodeId) as EpisodeShareRow | undefined;
}

/** Share tokens of the episode's snips that a recipient can open right now, in episode order. */
function publicSnipTokens(ctx: AppContext, episodeId: string): { share_token: string; start_ms: number }[] {
  return ctx.db
    .prepare(
      `SELECT s.share_token, r.start_ms FROM snip s
         JOIN audio_asset a ON a.id = s.audio_asset_id
         JOIN snip_revision r ON r.id = s.current_revision_id
        WHERE a.episode_id = ? AND s.deleted_at IS NULL AND s.share_state = 'active' AND r.status = 'ready' AND r.clip_path IS NOT NULL
        ORDER BY r.start_ms, s.created_at`,
    )
    .all(episodeId) as { share_token: string; start_ms: number }[];
}

function toView(ctx: AppContext, row: EpisodeShareRow): EpisodeShareView {
  return { share_url: episodeShareUrl(ctx, row.share_token), state: row.share_state, snip_count: publicSnipTokens(ctx, row.episode_id).length, created_at: row.created_at };
}

/** The episode's share link, or null when it has never been shared. */
export function getEpisodeShare(ctx: AppContext, episodeId: string): EpisodeShareView | null {
  getEpisodeRow(ctx, episodeId);
  const row = shareRow(ctx, episodeId);
  return row ? toView(ctx, row) : null;
}

/** Share the episode: creates its link the first time, and reactivates the same link after a revoke. */
export function shareEpisode(ctx: AppContext, episodeId: string): EpisodeShareView {
  getEpisodeRow(ctx, episodeId);
  const row = shareRow(ctx, episodeId);
  if (!row) {
    ctx.db.prepare("INSERT INTO episode_share (id, episode_id, share_token, share_state, created_at) VALUES (?, ?, ?, 'active', ?)").run(newId(), episodeId, newShareToken(), ctx.now());
    ctx.log("episode shared", { episode_id: episodeId });
  } else if (row.share_state === "revoked") {
    ctx.db.prepare("UPDATE episode_share SET share_state = 'active', revoked_at = NULL WHERE id = ?").run(row.id);
    ctx.log("episode share restored", { episode_id: episodeId });
  }
  return toView(ctx, shareRow(ctx, episodeId)!);
}

/** Withdraw the episode page. The snips' own links are untouched. */
export function revokeEpisodeShare(ctx: AppContext, episodeId: string): EpisodeShareView {
  getEpisodeRow(ctx, episodeId);
  const row = shareRow(ctx, episodeId);
  if (!row) throw notFound("episode share");
  if (row.share_state === "active") {
    ctx.db.prepare("UPDATE episode_share SET share_state = 'revoked', revoked_at = ? WHERE id = ?").run(ctx.now(), row.id);
    ctx.log("episode share revoked", { episode_id: episodeId });
  }
  return toView(ctx, shareRow(ctx, episodeId)!);
}

/** Everything a recipient of `/e/{token}` may see. */
export function publicEpisode(ctx: AppContext, token: string): PublicEpisode {
  if (!SHARE_TOKEN_RE.test(token)) return { kind: "not_found" };
  const row = ctx.db.prepare("SELECT * FROM episode_share WHERE share_token = ?").get(token) as EpisodeShareRow | undefined;
  if (!row) return { kind: "not_found" };
  if (row.share_state !== "active") return { kind: "gone" };
  const episode = getEpisodeRow(ctx, row.episode_id);
  const feed = ctx.db.prepare("SELECT title, site_url, is_private FROM feed WHERE id = ?").get(episode.feed_id) as { title: string | null; site_url: string | null; is_private: number };
  const isPublic = feed.is_private === 0;
  const snips: PublicEpisodeSnip[] = [];
  for (const { share_token, start_ms } of publicSnipTokens(ctx, row.episode_id)) {
    const v = publicSnip(ctx, share_token);
    if (v.kind !== "ready") continue;
    snips.push({ token: v.token, rev: v.rev, title: v.title, summary: v.summary, quote: v.quote, excerpt: v.excerpt, turns: v.turns, duration_ms: v.duration_ms, start_ms, page_path: `/s/${v.token}`, clip_path: `/s/${v.token}/r${v.rev}.mp3`, video: v.video ? { path: `/s/${v.token}/r${v.rev}.mp4`, poster_path: `/s/${v.token}/r${v.rev}.jpg`, width: v.video.width, height: v.video.height } : null });
  }
  return { kind: "ready", token, episode: { title: episode.title, public_url: isPublic ? episode.link : null }, show: { title: feed.title, site_url: isPublic ? feed.site_url : null }, snips };
}
