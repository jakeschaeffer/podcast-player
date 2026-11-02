import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { probeAudio } from "../src/lib/ffprobe.js";

const execFileAsync = promisify(execFile);

/** Podcast MP3s often embed their artwork, which ffprobe lists as a video stream. It must not make them videos. */
describe("probeAudio", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pp-probe-"));
    await execFileAsync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=red:size=300x300", "-frames:v", "1", "-update", "1", join(dir, "cover.png")]);
    await execFileAsync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-c:a", "libmp3lame", join(dir, "plain.mp3")]);
    await execFileAsync("ffmpeg", ["-v", "error", "-y", "-i", join(dir, "plain.mp3"), "-i", join(dir, "cover.png"), "-map", "0", "-map", "1", "-c", "copy", "-id3v2_version", "3", "-disposition:v", "attached_pic", join(dir, "cover.mp3")]);
    await execFileAsync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(dir, "clip.mp4")]);
  });

  it("treats an MP3 with embedded cover art as audio", async () => {
    const probe = await probeAudio(join(dir, "cover.mp3"));
    expect(probe.video).toBeNull();
    expect(probe.mime).toBe("audio/mpeg");
  });

  it("treats a real video as video", async () => {
    const probe = await probeAudio(join(dir, "clip.mp4"));
    expect(probe.video).toMatchObject({ width: 320, height: 240 });
    expect(probe.mime).toBe("video/mp4");
  });
});
