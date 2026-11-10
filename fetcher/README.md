# The home fetcher

Brings YouTube videos to the server (docs/video-plan.md). The server never fetches from YouTube: YouTube blocks
data-centre addresses, and its terms are a matter for the owner's own machine. This script runs on a box at home
(any Linux with systemd; the setup below was done on a TrueNAS), polls the server for videos the owner asked for,
downloads each with yt-dlp over the home connection, and uploads the MP4 and its captions. `snip_fetcher.py` has the
protocol at the top.

## What is on the box

- `~/yt-fetcher-venv`: a venv with `yt-dlp`, `imageio-ffmpeg` (a bundled ffmpeg, which yt-dlp needs to merge
  video and audio) and `curl-cffi` (so yt-dlp can look like a browser). TrueNAS's Python has no `ensurepip`, so
  the venv was made `--without-pip` and filled with another venv's pip (`pip --python …/bin/python install …`).
- `~/snip-fetcher/`: `snip_fetcher.py` (a copy of this directory's) and `ffmpeg` (a link to the bundled one), plus
  `work/` while a download runs. yt-dlp warns that YouTube extraction without a JavaScript runtime may miss formats;
  it worked without one for the first video. To add one, put the `deno` binary (denoland/deno releases) at
  `~/snip-fetcher/deno` and set `SNIP_JS_RUNTIME=deno:…/deno` in the service.
- `~/.config/snip-fetcher/token`: a device token for the server, made once with the owner password:
  `POST /v1/devices {"name": "Home fetcher", "platform": "cli", "password": …}`. Revoking that device in the app
  stops the fetcher.
- `~/.config/systemd/user/snip-fetcher.service`: a copy of `snip-fetcher.service` with `SNIP_SERVER` set to the
  server's address, looping every minute. `loginctl enable-linger <user>` keeps user services running without a
  login. A box that cannot resolve the server's name (a tailnet name without MagicDNS, say) sets `SNIP_SERVER_IP`
  too, and the script connects to that address while verifying the certificate against the name.

## Running it

```
systemctl --user status snip-fetcher     # or: journalctl --user -u snip-fetcher -f
~/snip-fetcher/snip_fetcher.py           # one pass by hand, with the service's environment set
```

Updating: copy the new `snip_fetcher.py` over and `systemctl --user restart snip-fetcher`. Updating yt-dlp (YouTube
changes often): `~/abs-session-venv/bin/python -m pip --python ~/yt-fetcher-venv/bin/python install -U yt-dlp`.

## Size, and why there is no transcoding

The fetcher takes YouTube's own H.264 at up to `SNIP_MAX_HEIGHT`, 480 by default since 2026-10-31 (about 150–250 MB
an hour; 720p is roughly twice that), and the server keeps at most `VIDEO_STORE_MAX_BYTES` (4 GB) of video, dropping
a finished episode's video a day after it was finished and otherwise the least recently played. (Files the server
fetches itself, which YouTube does not offer in sizes, are scaled down on the server to `VIDEO_MAX_HEIGHT`, 480 too.)
Re-encoding to HEVC here was measured on 2026-10-31 (i3-N305, software x265): 2.3× realtime at `veryfast`, and at a
quality that keeps 720p watchable (CRF 26) the file was 424 MB an hour against the source's 452, so it was not
worth a 25-minute wait per hour of video. The box's Intel iGPU could encode HEVC many times faster, but it would
need jake in the `render` group and an ffmpeg built with VAAPI/QSV (the bundled one has neither); even then the
saving at a watchable quality is modest, because YouTube's encode is already tight. The lever that works is
`SNIP_MAX_HEIGHT`: 480 halves 720p's size with no CPU at all, which is why it is the default.

## What it does when no video is wanted

Between downloads, slowly, it does the work that needs no download (`background()` in the script): captions due
another try, the older videos of a channel whose owner pressed "More videos", and the details of any video that has
none yet (description, length, thumbnail, date, chapters), a few a pass. A 429 from YouTube stops all of this for
`SNIP_BACKOFF_SECONDS` (an hour); a video the owner asked for is still tried. "More videos" pressed during that hour
answers at once with when to ask again, rather than waiting.

## When a download fails

The failure's message shows on the episode in the apps. "Sign in to confirm you're not a bot" means YouTube wants
more than a plain request: update yt-dlp first; if it goes on, the next step is cookies from a browser signed into
a spare Google account (`--cookies-from-browser`), which the script does not do yet.

Captions are a separate request after the video, so a 429 on them cannot cost the video. They are tried again after 1,
3, 6, 12 and 24 hours, and nothing is transcribed meanwhile, because that bills. After the last try the episode simply
has no transcript until the owner presses Transcribe. Only a video YouTube truly has no English captions for goes to
transcription on its own.
