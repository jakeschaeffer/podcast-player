import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeAudio } from "../../lib/ffprobe.js";
import { clipArgs, renderClip } from "./render.js";

const execFileAsync = promisify(execFile);

describe("clipArgs", () => {
  const args = clipArgs("/media/a.mp3", 61_500, 98_250, "/tmp/out.mp3");

  it("seeks on the input, limits with -t, and strips metadata and chapters", () => {
    expect(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 6)).toEqual(["-ss", "61.500", "-i", "/media/a.mp3", "-t", "36.750"]);
    expect(args).not.toContain("-to");
    expect(args).toContain("-map_metadata");
    expect(args[args.indexOf("-map_metadata") + 1]).toBe("-1");
    expect(args).toContain("-map_chapters");
    expect(args.filter((a) => a.startsWith("/"))).toEqual(["/media/a.mp3", "/tmp/out.mp3"]);
  });

  it("always encodes MP3", () => {
    expect(args[args.indexOf("-c:a") + 1]).toBe("libmp3lame");
    expect(args[args.indexOf("-f") + 1]).toBe("mp3");
  });

  it("rejects an empty or inverted span", () => {
    expect(() => clipArgs("/a", 10, 10, "/o")).toThrow(RangeError);
    expect(() => clipArgs("/a", 20, 10, "/o")).toThrow(RangeError);
  });
});

describe("renderClip", () => {
  let dir: string;
  let src: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clip-"));
    src = join(dir, "tone.mp3");
    await execFileAsync("ffmpeg", ["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=12", "-c:a", "libmp3lame", "-b:a", "96k", src]);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("renders a clip whose measured duration matches the span and places it atomically", async () => {
    const out = join(dir, "clips", "r1.mp3");
    const clip = await renderClip(src, 2_000, 5_500, out);
    expect(clip.path).toBe(out);
    expect(Math.abs(clip.duration_ms - 3_500)).toBeLessThanOrEqual(250);
    expect(clip.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(out)).size).toBe(clip.bytes);
    const probe = await probeAudio(out);
    expect(probe.mime).toBe("audio/mpeg");
  });

  it("fails cleanly when the span is outside the file", async () => {
    const out = join(dir, "clips", "r2.mp3");
    await expect(renderClip(src, 20_000, 30_000, out)).rejects.toThrow();
    await expect(stat(out)).rejects.toThrow();
  });
});
