#!/bin/bash
# Fetch real responses from a running server (read-only GETs) and decode them with the app's models.
#   ios/scripts/check-live.sh http://localhost:8081      # e.g. production through `ssh -N -L 8081:127.0.0.1:8080 <your host>`
# The token comes from ~/.config/podcast-player/devauth.json (or SNIP_TOKEN). The responses hold private feed
# data, so they go to a temporary folder that is deleted afterwards, never into the repo.
set -euo pipefail
cd "$(dirname "$0")/../Packages/PodcastAPI"

BASE="${1:-http://localhost:8081}"
TOKEN="${SNIP_TOKEN:-$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.config/podcast-player/devauth.json')))['token'])")}"
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

get() { curl -sf -H "Authorization: Bearer $TOKEN" "$BASE$1" -o "$OUT/$2.json"; }
ids() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); d=d['items'] if isinstance(d,dict) else d; [print(x[sys.argv[2]]) for x in d if x.get(sys.argv[2])]" "$@"; }

get /v1/feeds feeds.list.all
for feed in $(ids "$OUT/feeds.list.all.json" id); do
  get "/v1/feeds/$feed" "feeds.get.$feed"
  get "/v1/episodes?feed_id=$feed&limit=50" "episodes.list.$feed"
  # Detail and transcript for every episode on the first page, whatever its processing state.
  for ep in $(ids "$OUT/episodes.list.$feed.json" id); do get "/v1/episodes/$ep" "episodes.get.$ep"; done
  for tr in $(ids "$OUT/episodes.list.$feed.json" transcript_id | head -5); do get "/v1/transcripts/$tr" "transcripts.get.$tr"; done
done
get "/v1/episodes?limit=30" episodes.list.today
get "/v1/snips?limit=50" snips.list.all

echo "==> decoding $(ls "$OUT" | wc -l | tr -d ' ') responses from $BASE"
PODCAST_API_LIVE_DIR="$OUT" swift test --filter decodesLiveResponses 2>&1 | grep -E "error:|✘|recorded an issue|Test run with"
