import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type AudioProbe = {
  duration_ms: number;
  bytes: number;
  /** Container as ffprobe names it, e.g. `mp3`, `mov,mp4,m4a,3gp,3g2,mj2`. */
  format_name: string;
  codec: string | null;
  channels: number | null;
  sample_rate: number | null;
  mime: string;
  /** The picture, when the file is a video (docs/video-plan.md); null for audio. */
  video: { codec: string | null; width: number; height: number } | null;
};

/**
 * Measure an audio or video file with ffprobe. The returned duration is what every timestamp in the
 * system is relative to; feed-declared durations are never used for arithmetic. A video's `mime` is the
 * container's video type (`video/mp4`), and `video` says its size.
 */
export async function probeAudio(path: string): Promise<AudioProbe> {
  const { size } = await stat(path);
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,channels,sample_rate,width,height:stream_disposition=attached_pic",
      "-of", "json",
      path,
    ],
    { maxBuffer: 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string; format_name?: string };
    streams?: { codec_type?: string; codec_name?: string; channels?: number; sample_rate?: string; width?: number; height?: number; disposition?: { attached_pic?: number } }[];
  };
  const durationSec = Number(parsed.format?.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`ffprobe: no usable duration for ${path}`);
  }
  const audio = parsed.streams?.find((s) => s.codec_type === "audio");
  if (!audio) throw new Error(`ffprobe: no audio stream in ${path}`);
  // Cover art in an audio file is a "video" stream too (an attached picture); a real picture has a size and no such flag.
  const picture = parsed.streams?.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic && (s.width ?? 0) > 0 && (s.height ?? 0) > 0);
  const format_name = parsed.format?.format_name ?? "";
  const video = picture ? { codec: picture.codec_name ?? null, width: picture.width!, height: picture.height! } : null;
  return {
    duration_ms: Math.round(durationSec * 1000),
    bytes: size,
    format_name,
    codec: audio.codec_name ?? null,
    channels: audio.channels ?? null,
    sample_rate: audio.sample_rate ? Number(audio.sample_rate) : null,
    mime: video ? videoMimeFor(format_name) : mimeFor(format_name, audio.codec_name ?? ""),
    video,
  };
}

export function videoMimeFor(format_name: string): string {
  const f = format_name.split(",")[0] ?? "";
  if (f === "mov" || f === "mp4" || format_name.includes("mp4")) return "video/mp4";
  if (f === "matroska" || f === "webm") return "video/webm";
  return "application/octet-stream";
}

export function mimeFor(format_name: string, codec: string): string {
  const f = format_name.split(",")[0] ?? "";
  if (f === "mp3") return "audio/mpeg";
  if (f === "mov" || f === "mp4" || format_name.includes("m4a")) return codec === "alac" ? "audio/mp4" : "audio/mp4";
  if (f === "ogg") return codec === "opus" ? "audio/ogg; codecs=opus" : "audio/ogg";
  if (f === "wav") return "audio/wav";
  if (f === "flac") return "audio/flac";
  if (f === "aac") return "audio/aac";
  if (f === "matroska" || f === "webm") return "audio/webm";
  return "application/octet-stream";
}
