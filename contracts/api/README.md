# Recorded API responses

One file per endpoint and state, recorded from the real server code by `server/test/api-fixtures.test.ts`
against an in-memory database with fake transcription and a scripted text model. Each file is:

```json
{ "request": { "method": "GET", "url": "/v1/snips/…", "body": { } }, "status": 200, "body": { } }
```

**What they are for.** The native app's API client decodes every `body` here in its unit tests (a *consumer
contract test*). When a server change would break the app's models, that test fails in the same change. The web
client gets the same guarantee from its generated types (`web/src/api/schema.d.ts`, built from
`server/openapi.json`).

**Keeping them current.** The server test fails when a file's shape (keys and value types) no longer matches
what the server returns, or when a recording is added or removed. Re-record with:

```bash
pnpm --dir server api-fixtures:update
```

Ids, tokens, signatures and timestamps differ on every recording; nothing should depend on their values. The
device token in `devices.create.json` belongs to a throwaway test database.

| Files | Covers |
| --- | --- |
| `devices.create` | Login (`platform: "ios"`) |
| `feeds.list`, `feeds.get` | Library |
| `search.shows`, `feeds.create`, `errors.conflict.feed` | Add a show: search results (`feed_id` set when already subscribed), subscribing in manual mode, subscribing twice |
| `episodes.list`, `episodes.get` | Today / feed lists; the player (signed `audio_url`, `resume`, `chapters`, `summary`) |
| `queue.list` | Up next: started, unfinished episodes, most recently listened first |
| `transcripts.get` | Transcript words as `[start_ms, end_ms, text]` tuples |
| `playback.report` | `PUT /v1/playback/{asset_id}` with `observed_at` |
| `snips.create`, `snips.create.selecting`, `snips.create.waiting` | A tap: on a transcribed recording, and on one still waiting for its transcript |
| `snips.get.ready`, `snips.get.failed` | The result card's end states |
| `snips.edit` | A boundary edit with `if_revision` (new revision, `preparing`) |
| `snips.list` | The Snips screen |
| `episodes.share.create`, `episodes.share.get` | Share all |
| `public.snip`, `public.episode` | What a shared link's `.json` twin returns (for rendering universal links) |
| `errors.unauthorized`, `errors.bad_request`, `errors.conflict` | The `{ "error": { "code", "message" } }` envelope at 401, 400 and 409 |
| `jobs.list`, `health` | Status |
| `prompts.list`, `prompts.version.get` | The Prompts screen: the repository's prompts with their versions and scores, one version's text, previous version and runs |
| `evals.runs.create`, `evals.runs.get` | Running a version's eval (queued) and a finished run's cases, from a scratch result file |
