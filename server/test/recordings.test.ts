import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ForcedAligner, ForcedAlignmentResult } from "../src/adapters/forcedAlignment.js";
import type { Transcriber } from "../src/adapters/transcriber.js";
import type { RawTranscript } from "../src/core/transcript/types.js";
import type { AppContext } from "../src/app/context.js";
import type { AudioAssetRow, EpisodeRow, PlaybackStateRow } from "../src/db/rows.js";
import { PRIORITY } from "../src/jobs/queue.js";
import { drain } from "../src/jobs/worker.js";
import { newId } from "../src/lib/ids.js";
import { PRUNE_AFTER_FINISHED_MS, pruneVideoJob, pruneVideosToCap, storeCaptions, storeVideoFile } from "../src/services/video.js";
import { storeEpisodeText } from "../src/services/publisherText.js";
import { getEpisode } from "../src/services/episodes.js";
import { reportPlayback, resumeFor } from "../src/services/playback.js";
import { testContext } from "./helpers/context.js";

const execFileAsync = promisify(execFile);

class CountingTranscriber implements Transcriber {
  readonly name = "fake";
  calls = 0;
  async transcribe(input: { duration_ms: number }): Promise<RawTranscript> {
    this.calls++;
    const words = ["Spoken", "words", "from", "the", "recording."].map((text, i) => ({ text, start_ms: 100 + i * 200, end_ms: 280 + i * 200, speaker: "speaker_A" }));
    return { provider: "fake", model: "script", language: "eng", words, events: [], duration_ms: input.duration_ms, cost_cents: 1 };
  }
}

class CountingAligner implements ForcedAligner {
  readonly name = "fake";
  calls = 0;
  async align(input: { duration_ms: number; text: string }): Promise<ForcedAlignmentResult> {
    this.calls++;
    const tokens = input.text.split(/\s+/).filter(Boolean);
    const step = Math.floor(input.duration_ms / (tokens.length + 1));
    return { words: tokens.map((text, i) => ({ text, start_ms: i * step, end_ms: i * step + step - 1, loss: 0.2 })), loss: 0.2, cost_cents: 1, elapsed_ms: 1 };
  }
}

/**
 * An episode can hold several recordings: the feed's audio, and a video with its own audio track and timeline. These
 * tests pin which one the episode plays, what each keeps, and which transcripts it pays for.
 */
describe("an episode's recordings", () => {
  let dir: string;
  let fixtures: Server;
  let baseUrl: string;
  let ctx: AppContext;
  let transcriber: CountingTranscriber;
  let aligner: CountingAligner;
  let feedId: string;
  let device: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "pp-recordings-"));
    await execFileAsync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=red:size=300x300", "-frames:v", "1", "-update", "1", join(dir, "cover.png")]);
    await execFileAsync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-c:a", "libmp3lame", join(dir, "plain.mp3")]);
    await execFileAsync("ffmpeg", ["-v", "error", "-y", "-i", join(dir, "plain.mp3"), "-i", join(dir, "cover.png"), "-map", "0", "-map", "1", "-c", "copy", "-id3v2_version", "3", "-disposition:v", "attached_pic", join(dir, "cover.mp3")]);
    await execFileAsync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(dir, "clip.mp4")]);
    await execFileAsync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10", "-f", "lavfi", "-i", "sine=frequency=550", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(dir, "longer.mp4")]);
    fixtures = createServer((req, res) => {
      res.writeHead(200, { "content-type": "audio/mpeg" }).end(readFileSync(join(dir, (req.url ?? "/").slice(1))));
    });
    await new Promise<void>((resolve) => fixtures.listen(0, "127.0.0.1", resolve));
    const addr = fixtures.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(() => fixtures.close());

  beforeEach(() => {
    transcriber = new CountingTranscriber();
    aligner = new CountingAligner();
    ctx = testContext({ transcriber, aligner });
    feedId = newId();
    device = newId();
    ctx.db.prepare("INSERT INTO feed (id, url_enc, url_hash, title, created_at) VALUES (?, ?, ?, 'Show', 0)").run(feedId, Buffer.from("x"), feedId);
    ctx.db.prepare("INSERT INTO device (id, name, platform, token_hash, created_at) VALUES (?, 'phone', 'ios', ?, 0)").run(device, device);
  });

  const addEpisode = (file = "plain.mp3"): string => {
    const id = newId();
    ctx.db
      .prepare("INSERT INTO episode (id, feed_id, guid, title, first_seen_at, enclosure_url_enc, enclosure_type, media_kind) VALUES (?, ?, ?, 'Episode', 0, ?, 'audio/mpeg', 'audio')")
      .run(id, feedId, id, ctx.secrets.encrypt(`${baseUrl}/${file}`));
    return id;
  };
  const queueFetch = (episodeId: string) => ctx.queue.enqueue("fetch_audio", `fetch_audio:${episodeId}`, { episode_id: episodeId, then: "transcribe" }, { priority: PRIORITY.catalog });
  const episode = (id: string) => ctx.db.prepare("SELECT * FROM episode WHERE id = ?").get(id) as EpisodeRow;
  const asset = (id: string) => ctx.db.prepare("SELECT * FROM audio_asset WHERE id = ?").get(id) as AudioAssetRow;
  const assets = (episodeId: string) => ctx.db.prepare("SELECT * FROM audio_asset WHERE episode_id = ? ORDER BY created_at, rowid").all(episodeId) as AudioAssetRow[];
  const sources = (assetId: string) => ctx.db.prepare("SELECT source FROM transcript WHERE audio_asset_id = ? ORDER BY created_at, rowid").pluck().all(assetId) as string[];
  const currentSource = (assetId: string) => ctx.db.prepare("SELECT t.source FROM audio_asset a JOIN transcript t ON t.id = a.transcript_id WHERE a.id = ?").pluck().get(assetId) as string | undefined;
  const uploadVideo = async (episodeId: string, file = "clip.mp4") => {
    const tmp = join(dir, `${newId()}.upload`);
    copyFileSync(join(dir, file), tmp);
    return storeVideoFile(ctx, episodeId, tmp);
  };
  const addArticle = (episodeId: string, kind: string) =>
    storeEpisodeText(ctx, {
      episode: episode(episodeId), source: "rss", source_ref: newId(), received_at: 0, align: false,
      article: { title: "Episode", kind, text: "The publisher wrote these words.", word_count: 5, paragraphs: [{ text: "The publisher wrote these words.", speaker: null, quote: false, section: 0 }], sections: [] } as never,
    }).id;

  it("keeps an MP3 with embedded cover art as plain audio, and transcribes it", async () => {
    const id = addEpisode("cover.mp3");
    queueFetch(id);
    const { outcomes } = await drain(ctx, { kinds: ["fetch_audio", "transcribe"] });
    expect(outcomes.failed).toBe(0);
    const [only] = assets(id);
    expect(only).toMatchObject({ mime: "audio/mpeg", video_path: null });
    expect(episode(id).current_asset_id).toBe(only!.id);
    expect(currentSource(only!.id)).toBe("asr");
  });

  it("plays a video's own audio track once it arrives, and keeps the feed's recording with its transcript and place", async () => {
    const id = addEpisode();
    queueFetch(id);
    await drain(ctx, { kinds: ["fetch_audio", "transcribe"] });
    const feedAudio = episode(id).current_asset_id!;
    reportPlayback(ctx, device, feedAudio, { position_ms: 1000, speed: 1, playing: false, finished: false, seq: 1 });

    const video = await uploadVideo(id);
    expect(video.id).not.toBe(feedAudio);
    expect(episode(id).current_asset_id).toBe(video.id);
    expect(video.mime).toBe("audio/mp4"); // the track pulled out of the video, not the feed's MP3
    expect(asset(feedAudio)).toMatchObject({ mime: "audio/mpeg", video_path: null });
    expect(sources(feedAudio)).toEqual(["asr"]);
    expect(ctx.db.prepare("SELECT position_ms FROM playback_state WHERE audio_asset_id = ?").pluck().get(feedAudio)).toBe(1000);
  });

  it("stays on the video's audio track when the video file is dropped", async () => {
    const id = addEpisode();
    queueFetch(id);
    await drain(ctx, { kinds: ["fetch_audio", "transcribe"] });
    const video = await uploadVideo(id);
    reportPlayback(ctx, device, video.id, { position_ms: 1500, speed: 1, playing: false, finished: true, seq: 1 });
    await pruneVideoJob(ctx, { payload: { asset_id: video.id } } as never);
    expect(asset(video.id).video_path).toBeNull();
    expect(episode(id).current_asset_id).toBe(video.id);
  });

  describe("your place when a video replaces the recording", () => {
    const withFeedAudio = async () => {
      const id = addEpisode();
      queueFetch(id);
      await drain(ctx, { kinds: ["fetch_audio", "transcribe"] });
      return { id, feedAudio: episode(id).current_asset_id! };
    };
    const place = (assetId: string) => ctx.db.prepare("SELECT * FROM playback_state WHERE device_id = ? AND audio_asset_id = ?").get(device, assetId) as PlaybackStateRow | undefined;

    it("carries over when the two recordings are the same length, and the device's next report is accepted", async () => {
      const { id, feedAudio } = await withFeedAudio();
      reportPlayback(ctx, device, feedAudio, { position_ms: 1000, speed: 1.5, playing: true, finished: false, seq: 7, observed_at: 500 });
      const video = await uploadVideo(id);
      expect(getEpisode(ctx, id, device).resume).toMatchObject({ position_ms: 1000, speed: 1.5, finished: false });
      expect(place(video.id)).toMatchObject({ playing: 0, observed_at: 500 });
      expect(place(feedAudio)!.position_ms).toBe(1000);
      expect(reportPlayback(ctx, device, video.id, { position_ms: 1200, speed: 1, playing: true, finished: false, seq: 8 }).accepted).toBe(true);
    });

    it("carries each device's own place", async () => {
      const { id, feedAudio } = await withFeedAudio();
      const tablet = newId();
      ctx.db.prepare("INSERT INTO device (id, name, platform, token_hash, created_at) VALUES (?, 'tablet', 'ios', ?, 0)").run(tablet, tablet);
      reportPlayback(ctx, device, feedAudio, { position_ms: 1000, speed: 1, playing: false, finished: false, seq: 1, observed_at: 100 });
      reportPlayback(ctx, tablet, feedAudio, { position_ms: 400, speed: 1, playing: false, finished: false, seq: 1, observed_at: 200 });
      const video = await uploadVideo(id);
      expect(resumeFor(ctx, video.id)).toMatchObject({ position_ms: 400, device_name: "tablet" });
      expect(place(video.id)!.position_ms).toBe(1000);
    });

    it("keeps an episode finished when a video arrives afterwards", async () => {
      const { id, feedAudio } = await withFeedAudio();
      reportPlayback(ctx, device, feedAudio, { position_ms: 1900, speed: 1, playing: false, finished: true, seq: 1 });
      const video = await uploadVideo(id);
      expect(resumeFor(ctx, video.id)?.finished).toBe(true);
    });

    it("starts a recording of a different length from its own beginning", async () => {
      const { id, feedAudio } = await withFeedAudio();
      reportPlayback(ctx, device, feedAudio, { position_ms: 1000, speed: 1, playing: false, finished: false, seq: 1 });
      const video = await uploadVideo(id, "longer.mp4");
      expect(episode(id).current_asset_id).toBe(video.id);
      expect(resumeFor(ctx, video.id)).toBeNull();
    });

    it("follows a device still playing the old recording after the video arrives", async () => {
      const { id, feedAudio } = await withFeedAudio();
      reportPlayback(ctx, device, feedAudio, { position_ms: 500, speed: 1, playing: true, finished: false, seq: 1, observed_at: 100 });
      const video = await uploadVideo(id);
      expect(reportPlayback(ctx, device, feedAudio, { position_ms: 1400, speed: 1, playing: true, finished: false, seq: 2, observed_at: 200 }).state.audio_asset_id).toBe(feedAudio);
      expect(resumeFor(ctx, video.id)?.position_ms).toBe(1400);
      expect(reportPlayback(ctx, device, video.id, { position_ms: 1500, speed: 1, playing: true, finished: false, seq: 3 }).accepted).toBe(true);
    });

    it("does not let an old report replayed from an offline device move the place back", async () => {
      const { id, feedAudio } = await withFeedAudio();
      const video = await uploadVideo(id);
      reportPlayback(ctx, device, video.id, { position_ms: 1500, speed: 1, playing: false, finished: false, seq: 5, observed_at: 900 });
      reportPlayback(ctx, device, feedAudio, { position_ms: 200, speed: 1, playing: false, finished: false, seq: 2, observed_at: 300 });
      expect(resumeFor(ctx, video.id)?.position_ms).toBe(1500);
    });

    it("leaves a restored recording's newer place alone", async () => {
      const { id, feedAudio } = await withFeedAudio();
      reportPlayback(ctx, device, feedAudio, { position_ms: 300, speed: 1, playing: false, finished: false, seq: 1, observed_at: 100 });
      const video = await uploadVideo(id);
      reportPlayback(ctx, device, video.id, { position_ms: 1500, speed: 1, playing: false, finished: true, seq: 2, observed_at: 200 });
      await pruneVideoJob(ctx, { payload: { asset_id: video.id } } as never);
      await uploadVideo(id);
      expect(resumeFor(ctx, video.id)).toMatchObject({ position_ms: 1500, finished: true });
    });

    it("sets the video's prune going when the old recording is finished", async () => {
      const { id, feedAudio } = await withFeedAudio();
      const video = await uploadVideo(id);
      reportPlayback(ctx, device, feedAudio, { position_ms: 1900, speed: 1, playing: false, finished: true, seq: 1 });
      expect(ctx.db.prepare("SELECT COUNT(*) FROM job WHERE key = ?").pluck().get(`prune_video:${video.id}`)).toBe(1);
    });
  });

  it("gives a dropped video back to its recording when the same file is fetched again, keeping transcript and place", async () => {
    const id = addEpisode();
    const first = await uploadVideo(id);
    storeCaptions(ctx, id, { events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "hello there" }] }] } as never, { language: "en", kind: "manual" } as never);
    reportPlayback(ctx, device, first.id, { position_ms: 1500, speed: 1, playing: false, finished: true, seq: 1 });
    await pruneVideoJob(ctx, { payload: { asset_id: first.id } } as never);

    const again = await uploadVideo(id);
    expect(again.id).toBe(first.id);
    expect(assets(id)).toHaveLength(1);
    expect(asset(first.id).video_path).not.toBeNull();
    expect(asset(first.id).video_sha256).toBe(first.video_sha256);
    expect(sources(first.id)).toEqual(["captions"]);
  });

  it("does not drop a restored video straight away to make room, however old its recording is", async () => {
    let now = 1_000_000_000_000;
    ctx = testContext({ transcriber, aligner, now: () => now, config: { videoStoreMaxBytes: 1 } });
    ctx.db.prepare("INSERT INTO feed (id, url_enc, url_hash, title, created_at) VALUES (?, ?, ?, 'Show', 0)").run(feedId, Buffer.from("x"), feedId);
    ctx.db.prepare("INSERT INTO device (id, name, platform, token_hash, created_at) VALUES (?, 'phone', 'ios', ?, 0)").run(device, device);
    const id = addEpisode();
    const first = await uploadVideo(id);
    now += 10 * PRUNE_AFTER_FINISHED_MS;
    await pruneVideosToCap(ctx);
    expect(asset(first.id).video_path).toBeNull(); // past its grace and over the cap

    await uploadVideo(id);
    expect(asset(first.id).video_path).not.toBeNull();
  });

  it("still gets the speech transcript an interview needs when its article is aligned first", async () => {
    const id = addEpisode();
    addArticle(id, "interview");
    queueFetch(id);
    await drain(ctx, { kinds: ["fetch_audio"] });
    const assetId = episode(id).current_asset_id!;
    await drain(ctx, { kinds: ["align_text"] }); // the article wins the race: transcribe has not started
    expect(sources(assetId)).toEqual(["rss"]);

    await drain(ctx, { kinds: ["transcribe"] });
    expect(transcriber.calls).toBe(1);
    expect(sources(assetId)).toEqual(["rss", "asr"]);
    expect(currentSource(assetId)).toBe("asr");
  });

  it("shows an update's article whichever transcript lands first, and still gets the speech for ad detection", async () => {
    for (const order of [["align_text", "transcribe"], ["transcribe", "align_text"]] as const) {
      const id = addEpisode();
      addArticle(id, "update");
      queueFetch(id);
      await drain(ctx, { kinds: ["fetch_audio"] });
      for (const kind of order) await drain(ctx, { kinds: [kind] });
      const assetId = episode(id).current_asset_id!;
      expect([...sources(assetId)].sort()).toEqual(["asr", "rss"]);
      expect(currentSource(assetId)).toBe("rss");
    }
  });

  it("does not transcribe a recording again once it has speech or captions", async () => {
    const id = addEpisode();
    const video = await uploadVideo(id);
    storeCaptions(ctx, id, { events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "hello there" }] }] } as never, { language: "en", kind: "manual" } as never);
    ctx.queue.enqueue("transcribe", `transcribe:${video.id}`, { asset_id: video.id });
    await drain(ctx, { kinds: ["transcribe"] });
    expect(transcriber.calls).toBe(0);
  });

  it("aligns the episode's article against a video that replaces its recording", async () => {
    const id = addEpisode();
    addArticle(id, "update");
    queueFetch(id);
    await drain(ctx, { kinds: ["fetch_audio", "align_text", "transcribe"] });
    expect(aligner.calls).toBe(1);

    const video = await uploadVideo(id);
    await drain(ctx, { kinds: ["align_text"] });
    expect(aligner.calls).toBe(2);
    expect(sources(video.id)).toEqual(["rss"]);
    expect(currentSource(video.id)).toBe("rss");
  });

  it("does not pay to transcribe a recording the episode has moved on from, unless a snip waits on it", async () => {
    const id = addEpisode();
    ctx.queue.enqueue("fetch_audio", `fetch_audio:${id}`, { episode_id: id, then: "none" });
    await drain(ctx, { kinds: ["fetch_audio"] });
    const feedAudio = episode(id).current_asset_id!;
    await uploadVideo(id);
    ctx.queue.enqueue("transcribe", `transcribe:${feedAudio}`, { asset_id: feedAudio });
    await drain(ctx, { kinds: ["transcribe"] });
    expect(transcriber.calls).toBe(0);

    const another = addEpisode();
    ctx.queue.enqueue("fetch_audio", `fetch_audio:${another}`, { episode_id: another, then: "none" });
    await drain(ctx, { kinds: ["fetch_audio"] });
    const waited = episode(another).current_asset_id!;
    const snip = newId();
    const revision = newId();
    ctx.db.prepare("INSERT INTO snip (id, audio_asset_id, anchor_ms, heard_from_ms, client_request_id, share_token, share_state, created_at) VALUES (?, ?, 1000, 0, ?, ?, 'active', 0)").run(snip, waited, snip, snip);
    ctx.db.prepare("INSERT INTO snip_revision (id, snip_id, rev, method, start_ms, end_ms, summary_status, status, created_at) VALUES (?, ?, 1, 'auto', 0, 1000, 'pending', 'waiting', 0)").run(revision, snip);
    ctx.db.prepare("UPDATE snip SET current_revision_id = ? WHERE id = ?").run(revision, snip);
    await uploadVideo(another);
    ctx.queue.enqueue("transcribe", `transcribe:${waited}`, { asset_id: waited });
    await drain(ctx, { kinds: ["transcribe"] });
    expect(transcriber.calls).toBe(1);
  });
});
