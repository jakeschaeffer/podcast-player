# CLAUDE.md — working on podcast-player

A personal podcast player: a TypeScript server (`server/`: Fastify API plus a job worker, SQLite), a React/Vite PWA
(`web/`) and a native iOS app (`ios/`). The design is in [docs/core/](docs/core/README.md) (six core functions, each
with a spec and a status table); `server/README.md`, `web/README.md` and `ios/README.md` say how to run each piece,
and [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) how to run the whole thing on machines of your own. This file is the
operational quick reference: commands, and the side effects that cost real money or touch production.

**Nothing of one deployment is committed.** Hosts, ssh aliases, Apple team and bundle id, accounts, and the owner's
standing permissions live in gitignored files with committed examples (the table below) and in `CLAUDE.local.md`
beside this file, which sessions read with it. A fresh clone or worktree has none of them; the simulator, the tests
and a Debug build need none, and the scripts that do need one refuse with the file's name. Before opening a PR,
`git grep` for anything that belongs in those files (a hostname, a team id, an address) and move it.

## How work flows (read first)

GitHub is the source of truth. Work happens in a Claude session on the owner's Mac (the machine with Xcode, the
signing identities, the simulators, and ssh to the servers), one branch and PR per change, merged to `master`.

1. **Branch** from `origin/master`; never edit code on the server. The server's checkout only ever moves by
   `deploy/deploy.sh`, which refuses to run if tracked files there are edited.
2. **Test locally first**: `scripts/dev-snapshot.sh` copies production's database and audio to `./data`, then
   `scripts/dev-server.sh` runs the server on `127.0.0.1:8080` with every paid service forced off (no
   ElevenLabs, `TEXT_MODEL=none`, no feed refresh, no Gmail, no git push). The copy can't fetch feeds or
   recordings either: its `APP_SECRET` differs, so the stored URLs don't decrypt. Point the simulator at it with
   `-server.url http://localhost:8080` (`ios/CLAUDE.md`). From a worktree, point the script at the main checkout's
   snapshot (`DATA_DIR=$HOME/Projects/podcast-player/data scripts/dev-server.sh`); a bare run there makes an empty
   database, and the app signs itself out on the first 401. The Mac's `node_modules` were installed with pnpm 11
   (`corepack pnpm@11`); other majors refuse the store.
3. **Merge, then deploy**: `deploy/deploy.sh` (from the Mac; it runs itself on the server over ssh, at the host
   `deploy/local.env` names). It backs up the database, pushes any prompt commits the server made, fast-forwards
   to `origin/master`, installs, rebuilds the web app, waits for running jobs, restarts, and checks health.
   `--check` only reports.
4. **Final check on production**, only on episodes whose transcript is already ready (`CLAUDE.local.md` says how
   the Mac reaches it).
5. **Phone**: `ios/scripts/testflight.sh` builds and uploads to TestFlight (`ios/CLAUDE.md`).

Whether a session may merge its own PRs and deploy is the owner's standing instruction, recorded in
`CLAUDE.local.md`. Ask first for anything that bills (below) or deletes production data.

## Per-machine files (gitignored, each with a committed example)

| File | Holds | Needed by |
| --- | --- | --- |
| `.env.local` | server secrets and settings for a local run; `scripts/dev-server.sh` writes one | the server |
| `ios/Config/Local.xcconfig` | Apple team, org id (the app is `$(ORG_IDENTIFIER).Snip`), the server release builds start on | phone builds |
| `ios/scripts/local.env` | team, org id, App Store Connect key id and issuer | `ios/scripts/testflight.sh`, `asc.mjs` |
| `deploy/local.env` | the production host's ssh alias, user and checkout | `deploy/deploy.sh`, `scripts/dev-snapshot.sh` |
| `CLAUDE.local.md` | the owner's deployment notes and standing permissions | sessions |

## Build, test, run

- `pnpm install` at the root, then `pnpm -r typecheck` and `pnpm -r test` (server tests need no network and no
  API keys: adapters are faked; web tests cover the pure player and editor rules).
- `contracts/golden/` holds the shared algorithms' golden cases (heard tracking, In/Out rules, span selection,
  summary validation) that the Swift ports must reproduce. The TypeScript tests fail when a reference's behaviour
  changes; that means a new version string and file, not an edit (contracts/golden/README.md).
- `scripts/dev-server.sh` (paid services off; prefer it) or `pnpm --dir server dev` (whatever `.env.local` says) runs API + worker on `127.0.0.1:8080`; `pnpm --dir web dev` proxies `/v1`, `/m`, `/s`,
  `/e` to it.
- After any change to route schemas: `pnpm --dir server openapi:update` rewrites the committed contract
  `server/openapi.json` (a test fails until you do), then `pnpm --dir web gen:api` regenerates
  `web/src/api/schema.d.ts` from it. The native app builds against the same file. If a response shape changed,
  `pnpm --dir server api-fixtures:update` re-records `contracts/api/` (the native client's decode tests read it).

## Real side effects (read before running anything against a real database or the live host)

- **ElevenLabs bills per audio hour** (~22–23¢/h; `TRANSCRIPTION_CENTS_PER_HOUR`). Transcription is queued by:
  playing an untranscribed episode of an `auto_process` feed (`server/src/services/playback.ts`), creating a snip
  on an untranscribed recording (`server/src/services/snipJobs.ts`), and `POST /v1/episodes/{id}/process`.
  Publisher-text forced alignment bills at the same rate.
- **Codex quota**: every snip summary and episode summary is a `codex exec` call when `TEXT_MODEL=codex-cli`.
- **The deploy checkout commits to `master` by itself**: the Prompts screen's new versions, activations, and each
  eval run's scorecard are committed by the server and pushed to GitHub at once (`GIT_AUTO_PUSH=1` in
  production). A push that loses a race with a merge stays on the server until the next `deploy/deploy.sh`,
  which rebases and pushes it. So fetch before editing `server/prompts/`, and expect prompt commits on `master`
  that no PR made. A local server commits prompt edits to whatever branch is checked out (it never pushes).
- **Port 8080 is the systemd service in production.** Stop it (`sudo systemctl stop podcast-player`, as the service
  user) before `pnpm dev` on that host.
- **Snips publish automatically.** Creating a snip mints a live public link (`/s/{token}`), private feeds included.
- **Private data stays out of git**: eval fixtures and cases are gitignored (`evals/**/fixtures/`, `cases/`) because
  they hold listening history and private-feed text, and the committed scorecards carry aggregate scores only (the
  per-case rows, which quote the owner's own titles, stay in the gitignored JSON). Never commit them, and never put
  them in shared fixtures.
- **Whatever guards the public origin** (an access proxy, a tunnel) is configured outside this repo; check it
  before assuming what is protected. A browser login in front of `/v1` and `/m` blocks the native app, which is why
  the owner's phone reaches production another way (`deploy/README.md`, `CLAUDE.local.md`).
- **Restarting the service mid-transcription bills twice**: systemd gives it 30 s to stop and a killed job is
  claimed again. `deploy/deploy.sh` waits for running jobs; a bare `systemctl restart` doesn't.
- **Database backups** go to `data/backups/` on the server, one per deploy (`app-<time>-pre-deploy-<sha>.db`).
  Nothing prunes them; at about 60 MB each, check `du -sh data/backups` now and then.

## Conventions

- Time is integer milliseconds on one `audio_asset`; words are the coordinate system; models emit sentence ids,
  never timestamps (docs/core/README.md). Read stored word ranges against the revision's own `transcript_id`, not
  the asset's current pointer, which moves.
- Pure functions in `server/src/core/` (no I/O), jobs and services around them; evals import the pure functions.
- Every client write is idempotent (`client_request_id`, `seq`, `if_revision`). Keep it that way: an offline
  native outbox replays requests.
- The player engine's code (`web/src/player/engine.ts`, `heard.ts`) is the contract; `docs/core/01-playback.md`
  lags it.

## Cross-repo

This repo and `jakeschaeffer/audiobooth-fork` (the audiobook iOS app) share the snip workflow. The plan that ties
them together is [docs/cross-repo-snips-plan.md](docs/cross-repo-snips-plan.md), kept identical in both repos.
Starting the native app? Read [docs/native-app-start.md](docs/native-app-start.md).
In short: B's TypeScript is the reference implementation for heard tracking, span selection and summary
validation; a shared Swift package (`snipkit`) ports it, checked against golden fixtures B generates. Lessons
learned in either repo go in that plan or in each repo's own notes, dated.
