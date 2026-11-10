#!/usr/bin/env python3
"""The home fetcher (docs/video-plan.md): brings YouTube videos to the podcast player's server.

The server never talks to YouTube itself (its data-centre address is blocked, and the downloading is better kept
at home). This script runs on a home box, polls the server for videos the owner asked for, downloads
each with yt-dlp over the home connection, and uploads it with its captions:

    GET  /v1/video/wanted                         what to fetch
    PUT  /v1/episodes/{id}/video/file             the MP4 (H.264 + AAC, at most SNIP_MAX_HEIGHT tall), streamed
    PUT  /v1/episodes/{id}/video/captions?kind=   YouTube's captions (json3), which become the transcript
    POST /v1/episodes/{id}/video/done             nothing more to send
    POST /v1/episodes/{id}/video/failed           with a message, when a download fails
    POST /v1/episodes/{id}/video/captions/later   the video is here but its captions failed: nothing is transcribed

When no video is wanted, and paced so it stays well behind real fetches, it also does what needs no download:

    GET  /v1/video/captions/wanted                captions that failed earlier and are due another try
    GET  /v1/video/listings/wanted                channels whose owner asked for more videos
    PUT  /v1/feeds/{id}/videos                    a page of a channel's videos, newest first
    POST /v1/feeds/{id}/videos/failed             with a message, when a channel cannot be listed
    GET  /v1/video/metadata/wanted                videos whose details have not come yet
    PUT  /v1/episodes/{id}/video/metadata         a video's title, description, length, thumbnail, date and chapters

YouTube's 429 stops all of that for SNIP_BACKOFF_SECONDS. A wanted video is still tried: the owner asked for it.

Settings come from the environment (fetcher/README.md): SNIP_SERVER, SNIP_SERVER_IP, SNIP_TOKEN_FILE, SNIP_WORK_DIR,
SNIP_YTDLP, SNIP_FFMPEG, SNIP_JS_RUNTIME, SNIP_PACE_SECONDS, SNIP_BACKOFF_SECONDS. Standard library only, so it needs no packages beyond yt-dlp's own environment.
"""
import calendar
import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

SERVER = os.environ.get("SNIP_SERVER", "").rstrip("/")
# A box without MagicDNS cannot resolve the server's Tailscale name: connect to its Tailscale address instead, while
# still speaking TLS as the name, so the certificate is checked as usual.
SERVER_IP = os.environ.get("SNIP_SERVER_IP", "")
TOKEN_FILE = Path(os.environ.get("SNIP_TOKEN_FILE", "~/.config/snip-fetcher/token")).expanduser()
WORK = Path(os.environ.get("SNIP_WORK_DIR", "~/snip-fetcher/work")).expanduser()
YTDLP = os.environ.get("SNIP_YTDLP", "yt-dlp")
FFMPEG = os.environ.get("SNIP_FFMPEG", "")
JS_RUNTIME = os.environ.get("SNIP_JS_RUNTIME", "")
POLL_SECONDS = int(os.environ.get("SNIP_POLL_SECONDS", "60"))
# The best H.264 video up to SNIP_MAX_HEIGHT (480 by default, about 150–250 MB an hour from YouTube; 720 is about
# twice that) with AAC audio, merged without re-encoding; failing that, any single file up to that height. Re-encoding
# to HEVC on this box was measured and rejected (fetcher/README.md): too slow, and hardly smaller at a watchable quality.
MAX_HEIGHT = int(os.environ.get("SNIP_MAX_HEIGHT", "480"))
FORMAT = f"bv*[height<={MAX_HEIGHT}][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<={MAX_HEIGHT}]"
UPLOAD_TIMEOUT = 60 * 60
# The background work, per pass: a few requests with a wait between them, then the usual poll. About 3 videos' details a minute.
PACE_SECONDS = int(os.environ.get("SNIP_PACE_SECONDS", "8"))
BACKOFF_SECONDS = int(os.environ.get("SNIP_BACKOFF_SECONDS", "3600"))
DETAILS_PER_PASS = 3
LISTING_PAGE = 15
LISTING_PAGES_PER_PASS = 6
# yt-dlp's words for a video that will never have details. Anything else may pass, so it is not reported as final.
GONE = ("private video", "video unavailable", "has been removed", "members-only", "members only", "account associated with this video has been terminated")


def log(msg: str) -> None:
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


if not SERVER:
    sys.exit("SNIP_SERVER is not set: the podcast player's address, e.g. https://snip.example.com (fetcher/README.md)")


def token() -> str:
    try:
        return TOKEN_FILE.read_text().strip()
    except OSError as e:
        sys.exit(f"no device token at {TOKEN_FILE}: {e} (fetcher/README.md says how to make one)")


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """An HTTPS connection to SERVER_IP that presents, and verifies, the server's name."""

    def connect(self) -> None:
        sock = socket.create_connection((SERVER_IP, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)  # type: ignore[attr-defined]


def call(method: str, path: str, body: bytes | None = None, content_type: str | None = None, timeout: int = 60, body_file: Path | None = None) -> dict:
    headers = {"authorization": f"Bearer {token()}", "accept": "application/json"}
    if content_type:
        headers["content-type"] = content_type
    data: object = body if body is not None else b""
    if body_file is not None:
        headers["content-length"] = str(body_file.stat().st_size)
        data = body_file.open("rb")
    u = urlsplit(SERVER)
    if u.scheme != "https":
        conn: http.client.HTTPConnection = http.client.HTTPConnection(u.hostname or "", u.port, timeout=timeout)
    elif SERVER_IP:
        conn = PinnedHTTPSConnection(u.hostname or "", u.port, timeout=timeout)
    else:
        conn = http.client.HTTPSConnection(u.hostname or "", u.port, timeout=timeout)
    try:
        conn.request(method, path, body=data, headers=headers)  # a file body is streamed
        res = conn.getresponse()
        text = res.read().decode("utf-8", "replace")
        if res.status >= 400:
            raise RuntimeError(f"{method} {path} -> {res.status}: {text[:300]}")
        return json.loads(text) if text else {}
    finally:
        if hasattr(data, "close"):
            data.close()  # type: ignore[union-attr]
        conn.close()


def run(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True)


def read_json_object(path: Path) -> dict:
    """A JSON object yt-dlp printed to a file, or {} when it printed "NA" (the field was missing) or nothing."""
    try:
        text = path.read_text().strip()
    except OSError:
        return {}
    if not text.startswith("{"):
        return {}
    try:
        value = json.loads(text.splitlines()[0])
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


class RateLimited(RuntimeError):
    """YouTube said to slow down."""


# Background work waits until this time, after a 429; videos that failed to give details are skipped until a restart.
quiet_until = 0.0
skip_details: set[str] = set()


def ytdlp_args() -> list[str]:
    cmd = [YTDLP, "--no-progress", "--no-playlist"]
    if FFMPEG:
        cmd += ["--ffmpeg-location", FFMPEG]
    if JS_RUNTIME:
        cmd += ["--js-runtimes", JS_RUNTIME]
    return cmd


def ytdlp(args: list[str]) -> subprocess.CompletedProcess:
    res = run(ytdlp_args() + args)
    if res.returncode != 0:
        err = [l for l in (res.stderr or "").splitlines() if "ERROR" in l] or (res.stderr or res.stdout).splitlines()[-3:]
        message = "yt-dlp: " + " | ".join(l.strip() for l in err)[:400]
        if "429" in message or "Too Many Requests" in message or "confirm you" in message:
            raise RateLimited(message)
        raise RuntimeError(message)
    return res


def download_video(video_id: str, out: Path) -> Path:
    """The video alone as out/<id>.mp4. Captions are a separate request, so one failing cannot cost the video."""
    out.mkdir(parents=True, exist_ok=True)
    ytdlp(["-f", FORMAT, "--merge-output-format", "mp4", "-o", str(out / "%(id)s.%(ext)s"), f"https://youtu.be/{video_id}"])
    video = out / f"{video_id}.mp4"
    if not video.exists():
        raise RuntimeError("yt-dlp finished but left no MP4 (format not available?)")
    return video


def download_captions(video_id: str, out: Path) -> list[tuple[Path, str, str]]:
    """The video's caption files as (path, kind, language), best first; [] only when YouTube has none in English."""
    out.mkdir(parents=True, exist_ok=True)
    ytdlp([
        "--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", "en.*,en", "--sub-format", "json3",
        "--print-to-file", "%(subtitles)j", str(out / "subtitles.json"),
        "--print-to-file", "%(automatic_captions)j", str(out / "auto.json"),
        "-o", str(out / "%(id)s.%(ext)s"),
        f"https://youtu.be/{video_id}",
    ])
    # Which caption tracks exist, so an uploaded file is named for what it is: a creator's captions beat automatic ones.
    manual_all = read_json_object(out / "subtitles.json")
    manual = set(manual_all.keys())
    listed = [k for k in [*manual, *read_json_object(out / "auto.json").keys()] if k == "en" or k.startswith("en-")]
    captions: list[tuple[Path, str, str]] = []
    for f in sorted(out.glob(f"{video_id}.*.json3")):
        lang = f.name[len(video_id) + 1 : -len(".json3")]
        captions.append((f, "manual" if lang in manual else "auto", lang))
    # A track YouTube lists but yt-dlp did not save is a failure, not "no captions": that one would be transcribed, and billed.
    if listed and not captions:
        raise RuntimeError(f"captions listed ({listed[:3]}) but none saved")
    # Best first: a creator's track, then the original-language automatic track, then plain "en".
    captions.sort(key=lambda c: (c[1] != "manual", not c[2].endswith("-orig"), c[2]))
    return captions


def send_captions(episode_id: str, video_id: str, work: Path) -> None:
    """Fetch and upload the captions, then say done. Failing means later: the server transcribes nothing for that."""
    global quiet_until
    try:
        captions = download_captions(video_id, work)
        if captions:
            path, kind, lang = captions[0]
            base = lang.split("-")[0]
            r = call("PUT", f"/v1/episodes/{episode_id}/video/captions?kind={kind}&lang={base}", body=path.read_bytes(), content_type="application/json", timeout=600)
            log(f"  captions uploaded ({kind}, {lang}): {r.get('word_count')} words")
        else:
            log("  no captions in English")
        call("POST", f"/v1/episodes/{episode_id}/video/done")
        log("  done")
    except Exception as e:  # noqa: BLE001
        if isinstance(e, RateLimited):
            quiet_until = time.time() + BACKOFF_SECONDS
        message = str(e)[:500]
        log(f"  captions failed, will try later: {message}")
        # The video is already there, so nothing raised from here may be reported as the video failing.
        for attempt in range(3):
            try:
                r = call("POST", f"/v1/episodes/{episode_id}/video/captions/later", body=json.dumps({"message": message}).encode(), content_type="application/json")
                log(f"  next try at {r.get('retry_at')}")
                return
            except Exception as e2:  # noqa: BLE001
                log(f"  could not put the captions off (try {attempt + 1} of 3): {e2}")
                time.sleep(PACE_SECONDS)


def fetch_one(item: dict) -> None:
    global quiet_until
    episode_id, video_id = item["episode_id"], item["youtube_id"]
    work = WORK / video_id
    log(f"fetching {video_id} for {item.get('show_title') or '?'}: {item['title']}")
    try:
        try:
            video = download_video(video_id, work)
            log(f"  downloaded {video.stat().st_size // 1_000_000} MB")
            call("PUT", f"/v1/episodes/{episode_id}/video/file", content_type="video/mp4", timeout=UPLOAD_TIMEOUT, body_file=video)
            log("  video uploaded")
        except Exception as e:  # noqa: BLE001 - whatever went wrong, the server should hear why
            if isinstance(e, RateLimited):
                quiet_until = time.time() + BACKOFF_SECONDS
            message = str(e)[:500]
            log(f"  failed: {message}")
            try:
                call("POST", f"/v1/episodes/{episode_id}/video/failed", body=json.dumps({"message": message}).encode(), content_type="application/json")
            except Exception as e2:  # noqa: BLE001
                log(f"  could not report the failure: {e2}")
            return
        # From here the video is on the server: a caption problem is the captions', never the video's.
        send_captions(episode_id, video_id, work)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def retry_captions(item: dict) -> None:
    episode_id, video_id = item["episode_id"], item["youtube_id"]
    work = WORK / f"captions-{video_id}"
    log(f"captions again for {video_id}: {item['title']}")
    try:
        send_captions(episode_id, video_id, work)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def http_thumbnail(info: dict) -> str | None:
    url = info.get("thumbnail") or next((t.get("url") for t in reversed(info.get("thumbnails") or []) if t.get("url")), None)
    return url if isinstance(url, str) and url.startswith("https://") else None


def seconds_to_ms(value: object) -> int | None:
    return int(float(value) * 1000) if isinstance(value, (int, float)) and value >= 0 else None


def published_ms(info: dict) -> int | None:
    for key in ("release_timestamp", "timestamp"):
        if isinstance(info.get(key), (int, float)):
            return int(info[key] * 1000)
    day = info.get("upload_date")
    if isinstance(day, str) and len(day) == 8 and day.isdigit():
        return int(calendar.timegm((int(day[:4]), int(day[4:6]), int(day[6:8]), 0, 0, 0)) * 1000)
    return None


def details_of(info: dict) -> dict:
    """What the server keeps from yt-dlp's description of one video."""
    chapters = [
        {"start_ms": int(float(c["start_time"]) * 1000), "title": str(c["title"])[:500]}
        for c in info.get("chapters") or []
        if isinstance(c.get("start_time"), (int, float)) and c.get("title")
    ]
    body: dict = {"chapters": chapters[:500]}
    if info.get("title"):
        body["title"] = str(info["title"])[:1000]
    if isinstance(info.get("description"), str) and info["description"]:
        body["description"] = info["description"][:20000]
    for key, value in (("duration_ms", seconds_to_ms(info.get("duration"))), ("thumbnail_url", http_thumbnail(info)), ("published_at", published_ms(info))):
        if value is not None:
            body[key] = value
    return body


def fetch_details(item: dict) -> None:
    """One video's details, from one request. A 429 stops the background work; a video that is gone is told once."""
    episode_id, video_id = item["episode_id"], item["youtube_id"]
    try:
        res = ytdlp(["--skip-download", "--dump-json", "--no-warnings", f"https://youtu.be/{video_id}"])
        body = details_of(json.loads(res.stdout.splitlines()[-1]))
    except RateLimited:
        raise
    except Exception as e:  # noqa: BLE001
        message = str(e)[:500]
        log(f"  details of {video_id} failed: {message}")
        if any(word in message.lower() for word in GONE):
            body = {"unavailable": message}
        else:
            skip_details.add(video_id)
            return
    call("PUT", f"/v1/episodes/{episode_id}/video/metadata", body=json.dumps(body).encode(), content_type="application/json")
    log(f"  details of {video_id} sent")


def list_channel(item: dict) -> None:
    """Walk down the channel's videos until the server has enough new ones, or the channel ends."""
    feed_id, channel_id, offset, wanted = item["feed_id"], item["channel_id"], item["offset"], item["count"]
    log(f"listing channel {channel_id} from {offset} for {wanted} new videos")
    for _ in range(LISTING_PAGES_PER_PASS):
        res = ytdlp(["--yes-playlist", "--flat-playlist", "--dump-json", "--no-warnings", "--playlist-items", f"{offset + 1}:{offset + LISTING_PAGE}", f"https://www.youtube.com/channel/{channel_id}/videos"])
        videos = []
        for line in res.stdout.splitlines():
            info = json.loads(line)
            if not info.get("id") or not info.get("title"):
                continue
            video = {"youtube_id": info["id"], "title": str(info["title"])[:1000], "duration_ms": seconds_to_ms(info.get("duration")), "thumbnail_url": http_thumbnail(info), "published_at": published_ms(info)}
            videos.append(video)
        ended = len(videos) < LISTING_PAGE
        r = call("PUT", f"/v1/feeds/{feed_id}/videos", body=json.dumps({"videos": videos, "ended": ended}).encode(), content_type="application/json")
        log(f"  {len(videos)} listed, {r.get('added')} new, {r.get('wanted')} still wanted")
        offset += len(videos)
        if ended or not r.get("wanted"):
            return
        time.sleep(PACE_SECONDS)


def background() -> None:
    """Everything that needs no download, a little per pass, until YouTube says stop."""
    global quiet_until
    for item in call("GET", "/v1/video/listings/wanted").get("items", []):
        message = None
        if time.time() >= quiet_until:
            try:
                list_channel(item)
            except RateLimited as e:
                quiet_until = time.time() + BACKOFF_SECONDS
                log(f"  listing stopped, YouTube says slow down: {e}")
            except Exception as e:  # noqa: BLE001
                message = str(e)[:500]
                log(f"  listing failed: {message}")
        if time.time() < quiet_until:
            # Not a fault of the channel: say when asking again will work, rather than show yt-dlp's error.
            minutes = max(1, round((quiet_until - time.time()) / 60))
            message = f"YouTube is limiting requests. Try again in about {minutes} minutes."
            log(f"  listing put off: {message}")
        if message:
            call("POST", f"/v1/feeds/{item['feed_id']}/videos/failed", body=json.dumps({"message": message}).encode(), content_type="application/json")
        time.sleep(PACE_SECONDS)
    if time.time() < quiet_until:
        return
    try:
        for item in call("GET", "/v1/video/captions/wanted").get("items", [])[:DETAILS_PER_PASS]:
            retry_captions(item)
            time.sleep(PACE_SECONDS)
            if time.time() < quiet_until:
                return
        items = call("GET", f"/v1/video/metadata/wanted?limit={DETAILS_PER_PASS + len(skip_details)}").get("items", [])
        for item in [i for i in items if i["youtube_id"] not in skip_details][:DETAILS_PER_PASS]:
            fetch_details(item)
            time.sleep(PACE_SECONDS)
    except RateLimited as e:
        quiet_until = time.time() + BACKOFF_SECONDS
        log(f"  YouTube says slow down, waiting {BACKOFF_SECONDS // 60} min: {e}")


def once() -> int:
    wanted = call("GET", "/v1/video/wanted?limit=5").get("items", [])
    for item in wanted:
        fetch_one(item)
    if not wanted:
        background()
    return len(wanted)


def main() -> None:
    loop = "--loop" in sys.argv
    while True:
        try:
            n = once()
            if not loop:
                log(f"{n} fetched" if n else "nothing wanted")
                return
            if n == 0:
                time.sleep(POLL_SECONDS)
        except Exception as e:  # noqa: BLE001
            log(f"poll failed: {e}")
            if not loop:
                sys.exit(1)
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
