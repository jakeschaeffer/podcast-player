# Snip, a podcast player

A personal podcast player for one listener. A server subscribes to shows (private feeds included), keeps each
episode's recording, transcribes it, lines the publisher's text up with the audio when there is one, and finds the
ads. A web app and a native iOS app play it with the transcript following along. One tap snips the thought you just
heard: a clip with its own words and a title, published at a link you can send to anyone.

| Piece | What it is | Read |
| --- | --- | --- |
| `server/` | Fastify API and job worker over SQLite: feeds, recordings, transcripts, snips, public pages | [server/README.md](server/README.md) |
| `web/` | React PWA: Today, Library, the player with transcript and chapters, snips and the editor | [web/README.md](web/README.md) |
| `ios/` | SwiftUI app over the same API: offline downloads, Live Activity, video, karaoke read-along | [ios/README.md](ios/README.md) |
| `fetcher/` | Optional: brings YouTube videos in from a box at home, where YouTube allows downloads | [fetcher/README.md](fetcher/README.md) |
| `deploy/` | One working production setup: systemd, nginx, a Cloudflare tunnel | [deploy/README.md](deploy/README.md) |
| `contracts/`, `evals/` | Golden cases the Swift ports must match; the eval harnesses and their scorecards | [contracts/golden/README.md](contracts/golden/README.md) |
| `docs/` | The design: six core functions, the data model, the plans and the research behind them | [docs/core/README.md](docs/core/README.md), [docs/plan.md](docs/plan.md) |

## Running your own

[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) covers it: what to run, how the phone reaches it, and how to build the
app under your own Apple team. The short version, on a Mac with Node 22, pnpm, ffmpeg and Xcode 26:

```bash
pnpm install && pnpm -r test     # server and web tests; no keys, no network
scripts/dev-server.sh            # a local server with every paid service off; writes .env.local the first time
pnpm --dir web dev               # the web app on http://127.0.0.1:5173
ios/scripts/dev-build-run.sh     # the iOS app in the simulator, already pointed at that server
```

Transcription is ElevenLabs Scribe with your own key (about 22¢ an hour of audio); snip titles and episode
summaries come from the Codex CLI on your subscription. Both are optional: without them episodes still play and
snips still publish, with the excerpt's first words as the title.

## Working on it

[CLAUDE.md](CLAUDE.md) is the operational reference: commands, costs, and what touches production. Values that
belong to one deployment (an Apple team, a server's address, an ssh alias) live in gitignored files with committed
examples, so the code and docs carry nothing of anyone's.
