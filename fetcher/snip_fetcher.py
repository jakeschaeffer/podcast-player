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

Settings come from the environment (fetcher/README.md): SNIP_SERVER, SNIP_SERVER_IP, SNIP_TOKEN_FILE, SNIP_WORK_DIR,
SNIP_YTDLP, SNIP_FFMPEG, SNIP_JS_RUNTIME. Standard library only, so it needs no packages beyond yt-dlp's own environment.
"""
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


def download(video_id: str, out: Path) -> tuple[Path, list[tuple[Path, str, str]]]:
    """The video as out/<id>.mp4, and its caption files as (path, kind, language), best first."""
    out.mkdir(parents=True, exist_ok=True)
    cmd = [YTDLP, "--no-progress", "--no-playlist", "-f", FORMAT, "--merge-output-format", "mp4"]
    if FFMPEG:
        cmd += ["--ffmpeg-location", FFMPEG]
    if JS_RUNTIME:
        cmd += ["--js-runtimes", JS_RUNTIME]
    cmd += [
        "--write-subs", "--write-auto-subs", "--sub-langs", "en.*,en", "--sub-format", "json3",
        "--print-to-file", "%(subtitles)j", str(out / "subtitles.json"),
        "--print-to-file", "%(automatic_captions)j", str(out / "auto.json"),
        "-o", str(out / "%(id)s.%(ext)s"),
        f"https://youtu.be/{video_id}",
    ]
    res = run(cmd)
    if res.returncode != 0:
        err = [l for l in (res.stderr or "").splitlines() if "ERROR" in l] or (res.stderr or res.stdout).splitlines()[-3:]
        raise RuntimeError("yt-dlp: " + " | ".join(l.strip() for l in err)[:400])
    video = out / f"{video_id}.mp4"
    if not video.exists():
        raise RuntimeError("yt-dlp finished but left no MP4 (format not available?)")
    # Which caption tracks exist, so an uploaded file is named for what it is: a creator's captions beat automatic ones.
    manual = set(read_json_object(out / "subtitles.json").keys())
    captions: list[tuple[Path, str, str]] = []
    for f in sorted(out.glob(f"{video_id}.*.json3")):
        lang = f.name[len(video_id) + 1 : -len(".json3")]
        captions.append((f, "manual" if lang in manual else "auto", lang))
    # Best first: a creator's track, then the original-language automatic track, then plain "en".
    captions.sort(key=lambda c: (c[1] != "manual", not c[2].endswith("-orig"), c[2]))
    return video, captions


def fetch_one(item: dict) -> None:
    episode_id, video_id = item["episode_id"], item["youtube_id"]
    work = WORK / video_id
    log(f"fetching {video_id} for {item.get('show_title') or '?'}: {item['title']}")
    try:
        video, captions = download(video_id, work)
        log(f"  downloaded {video.stat().st_size // 1_000_000} MB; captions: {[(c[1], c[2]) for c in captions]}")
        call("PUT", f"/v1/episodes/{episode_id}/video/file", content_type="video/mp4", timeout=UPLOAD_TIMEOUT, body_file=video)
        log("  video uploaded")
        if captions:
            path, kind, lang = captions[0]
            base = lang.split("-")[0]
            r = call("PUT", f"/v1/episodes/{episode_id}/video/captions?kind={kind}&lang={base}", body=path.read_bytes(), content_type="application/json", timeout=600)
            log(f"  captions uploaded ({kind}, {lang}): {r.get('word_count')} words")
        call("POST", f"/v1/episodes/{episode_id}/video/done")
        log("  done")
    except Exception as e:  # noqa: BLE001 - whatever went wrong, the server should hear why
        message = str(e)[:500]
        log(f"  failed: {message}")
        try:
            call("POST", f"/v1/episodes/{episode_id}/video/failed", body=json.dumps({"message": message}).encode(), content_type="application/json")
        except Exception as e2:  # noqa: BLE001
            log(f"  could not report the failure: {e2}")
    finally:
        shutil.rmtree(work, ignore_errors=True)


def once() -> int:
    wanted = call("GET", "/v1/video/wanted?limit=5").get("items", [])
    for item in wanted:
        fetch_one(item)
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
