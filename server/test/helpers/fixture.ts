import { execFile } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Readwise } from "../../src/adapters/readwise.js";
import type { TextModel } from "../../src/adapters/textModel.js";
import type { AppContext } from "../../src/app/context.js";
import { newId } from "../../src/lib/ids.js";
import { testContext } from "./context.js";
import { buildTranscript } from "./transcript.js";

const execFileAsync = promisify(execFile);
export const DURATION_MS = 120_000;

export const PRICING = "The first thing we tried was a flat monthly fee for everyone. It felt simple and fair. Nobody upgraded for three months.";
export const GARDEN = "Tomatoes want full sun and deep watering. Pinch the side shoots every week. Mulch keeps the roots cool in summer.";

/** About two minutes of one speaker repeating a passage, so any anchor has whole sentences before it. */
export function transcriptAbout(passage: string) {
  return buildTranscript(Array.from({ length: 12 }, () => ({ speaker: "speaker_A", text: passage })));
}

/** A two-minute tone, rendered once per test file. */
export async function makeTone(): Promise<string> {
  const path = join(mkdtempSync(join(tmpdir(), "pp-tone-")), "tone.mp3");
  await execFileAsync("ffmpeg", ["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=330:duration=${DURATION_MS / 1000}`, "-c:a", "libmp3lame", "-b:a", "64k", path]);
  return path;
}

/**
 * A fresh database holding one feed, one episode, and one recording at `mp3`, with a clock the test can move.
 * Rows are written directly, so no feed fetch or download runs.
 */
export function recordingFixture(mp3: string, opts: { textModel?: TextModel; readwise?: Readwise } = {}): { ctx: AppContext; clock: { now: number }; assetId: string; episodeId: string } {
  const clock = { now: 1_800_000_000_000 };
  const ctx = testContext({ now: () => clock.now, ...(opts.textModel ? { textModel: opts.textModel } : {}), ...(opts.readwise ? { readwise: opts.readwise } : {}) });
  const feedId = newId();
  const episodeId = newId();
  const assetId = newId();
  ctx.db.prepare("INSERT INTO feed (id, url_enc, url_hash, title, created_at) VALUES (?, ?, ?, 'Fixture Show', ?)").run(feedId, Buffer.from("x"), feedId, clock.now);
  ctx.db.prepare("INSERT INTO episode (id, feed_id, guid, title, first_seen_at, enclosure_url_enc) VALUES (?, ?, 'g1', 'Pricing', ?, ?)").run(episodeId, feedId, clock.now, Buffer.from("x"));
  ctx.db
    .prepare("INSERT INTO audio_asset (id, episode_id, sha256, bytes, duration_ms, mime, path, created_at) VALUES (?, ?, ?, ?, ?, 'audio/mpeg', ?, ?)")
    .run(assetId, episodeId, assetId, statSync(mp3).size, DURATION_MS, mp3, clock.now);
  ctx.db.prepare("UPDATE episode SET current_asset_id = ? WHERE id = ?").run(assetId, episodeId);
  return { ctx, clock, assetId, episodeId };
}
