import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { probeAudio } from "../../lib/ffprobe.js";

const execFileAsync = promisify(execFile);

/** Rendered duration must match the requested span within this tolerance (docs/core/03). */
export const CLIP_TOLERANCE_MS = 250;
const FADE_S = 0.03;
/** Encoding is CPU work on a small host; one that has not finished by now is stuck, and the job retries it. */
const VIDEO_RENDER_TIMEOUT_MS = 10 * 60_000;

/**
 * The exact ffmpeg argv for a clip. Pure, so tests can assert on it.
 * Input seeking (`-ss` before `-i`) is accurate when transcoding; duration goes through `-t`, never `-to`,
 * which would be relative to the seek point. Metadata and chapters are stripped so nothing from the
 * parent file travels with the clip. Output is always MP3 so one format plays everywhere.
 */
export function clipArgs(assetPath: string, start_ms: number, end_ms: number, outPath: string): string[] {
  if (!(start_ms >= 0 && end_ms > start_ms)) throw new RangeError(`clipArgs: invalid span ${start_ms}..${end_ms}`);
  const start = (start_ms / 1000).toFixed(3);
  const duration_s = (end_ms - start_ms) / 1000;
  const fadeOutStart = Math.max(0, duration_s - FADE_S).toFixed(3);
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-ss", start, "-i", assetPath, "-t", duration_s.toFixed(3),
    "-map_metadata", "-1", "-map_chapters", "-1", "-vn",
    "-af", `afade=t=in:st=0:d=${FADE_S},afade=t=out:st=${fadeOutStart}:d=${FADE_S}`,
    "-c:a", "libmp3lame", "-b:a", "128k", "-ar", "44100",
    "-f", "mp3", outPath,
  ];
}

/** The tallest a clip's picture is kept; the fetcher's videos are 480p today, older ones 720p. */
const VIDEO_CLIP_MAX_HEIGHT = 720;

/**
 * The ffmpeg argv for a clip with its picture. Re-encoded rather than copied: a copy can only start on a keyframe, which
 * would show seconds from outside the span, and H.264 with AAC is what every browser and link preview plays.
 * `faststart` puts the index first, so a page can start playing before the file has finished arriving.
 */
export function videoClipArgs(videoPath: string, start_ms: number, end_ms: number, outPath: string): string[] {
  if (!(start_ms >= 0 && end_ms > start_ms)) throw new RangeError(`videoClipArgs: invalid span ${start_ms}..${end_ms}`);
  const start = (start_ms / 1000).toFixed(3);
  const duration_s = (end_ms - start_ms) / 1000;
  const fadeOutStart = Math.max(0, duration_s - FADE_S).toFixed(3);
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-ss", start, "-i", videoPath, "-t", duration_s.toFixed(3),
    "-map_metadata", "-1", "-map_chapters", "-1", "-map", "0:v:0", "-map", "0:a:0", "-sn", "-dn",
    "-vf", `scale=trunc(oh*a/2)*2:trunc(min(${VIDEO_CLIP_MAX_HEIGHT}\\,ih)/2)*2`,
    "-af", `afade=t=in:st=0:d=${FADE_S},afade=t=out:st=${fadeOutStart}:d=${FADE_S}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", "-threads", "2",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
    "-movflags", "+faststart", "-f", "mp4", outPath,
  ];
}

export type RenderedVideoClip = RenderedClip & { width: number; height: number; poster_path: string };

/** Where a video clip's poster image lives: beside it, with the same name. */
export function posterPath(videoClipPath: string): string {
  return videoClipPath.replace(/\.mp4$/, ".jpg");
}

/**
 * Render `[start_ms, end_ms)` of a video to `outPath` and a poster frame beside it, the same way as `renderClip`: via
 * temp files, with the duration verified, and nothing left behind on any failure.
 */
export async function renderVideoClip(videoPath: string, start_ms: number, end_ms: number, outPath: string): Promise<RenderedVideoClip> {
  await mkdir(dirname(outPath), { recursive: true });
  const stamp = `tmp-${process.pid}-${Date.now()}`;
  const tmp = `${outPath}.${stamp}`;
  const posterTmp = `${outPath}.${stamp}.jpg`;
  const poster_path = posterPath(outPath);
  try {
    await execFileAsync("ffmpeg", videoClipArgs(videoPath, start_ms, end_ms, tmp), { maxBuffer: 1024 * 1024, timeout: VIDEO_RENDER_TIMEOUT_MS });
    const probe = await probeAudio(tmp);
    const expected = end_ms - start_ms;
    if (Math.abs(probe.duration_ms - expected) > CLIP_TOLERANCE_MS) {
      throw new Error(`video clip duration ${probe.duration_ms} ms differs from requested ${expected} ms by more than ${CLIP_TOLERANCE_MS} ms`);
    }
    if (!probe.video) throw new Error("video clip has no picture");
    const at = Math.min(1, probe.duration_ms / 2000).toFixed(3);
    await execFileAsync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-ss", at, "-i", tmp, "-frames:v", "1", "-q:v", "4", "-f", "image2", posterTmp], { maxBuffer: 1024 * 1024 });
    const sha256 = await hashFile(tmp);
    await rename(posterTmp, poster_path);
    await rename(tmp, outPath);
    return { path: outPath, duration_ms: probe.duration_ms, bytes: probe.bytes, sha256, width: probe.video.width, height: probe.video.height, poster_path };
  } catch (err) {
    await rm(tmp, { force: true });
    await rm(posterTmp, { force: true });
    throw err;
  }
}

export type RenderedClip = { path: string; duration_ms: number; bytes: number; sha256: string };

/**
 * Render `[start_ms, end_ms)` of the asset to `outPath` via a temp file, verify the measured duration,
 * hash it, and move it into place atomically. Throws (and leaves nothing behind) on any mismatch.
 */
export async function renderClip(assetPath: string, start_ms: number, end_ms: number, outPath: string): Promise<RenderedClip> {
  await mkdir(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await execFileAsync("ffmpeg", clipArgs(assetPath, start_ms, end_ms, tmp), { maxBuffer: 1024 * 1024 });
    const probe = await probeAudio(tmp);
    const expected = end_ms - start_ms;
    if (Math.abs(probe.duration_ms - expected) > CLIP_TOLERANCE_MS) {
      throw new Error(`clip duration ${probe.duration_ms} ms differs from requested ${expected} ms by more than ${CLIP_TOLERANCE_MS} ms`);
    }
    const sha256 = await hashFile(tmp);
    await rename(tmp, outPath);
    return { path: outPath, duration_ms: probe.duration_ms, bytes: probe.bytes, sha256 };
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}
