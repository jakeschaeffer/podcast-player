#!/usr/bin/env bash
# Run the server on this Mac for testing, with every paid service forced off: no ElevenLabs (transcription and
# alignment jobs defer), no Codex (TEXT_MODEL=none), no feed refresh, no Gmail, no pushing to GitHub. Variables
# set here win over .env.local (node's --env-file never overrides the environment).
#   scripts/dev-server.sh            # API and worker on http://127.0.0.1:8080, data in ./data
#   scripts/dev-snapshot.sh          # first, to test against a copy of production's data
# The simulator app points at it with the launch argument `-server.url http://localhost:8080`; the web app with
# `pnpm --dir web dev`. A device token comes from POST /v1/devices with the OWNER_PASSWORD in .env.local.
set -euo pipefail
cd "$(dirname "$0")/.."

[ ! -e /etc/systemd/system/podcast-player.service ] || { echo "error: this is the production host; use deploy/deploy.sh" >&2; exit 1; }

if [ ! -f .env.local ]; then
  {
    echo "# Local test server (scripts/dev-server.sh). No paid-service keys belong in this file."
    echo "APP_SECRET=$(openssl rand -hex 32)"
    echo "OWNER_PASSWORD=$(openssl rand -hex 12)"
  } > .env.local
  echo "wrote .env.local with a new APP_SECRET and OWNER_PASSWORD"
fi
if grep -qE '^(ELEVENLABS_API_KEY|GOOGLE_REFRESH_TOKEN)=.' .env.local; then
  echo "note: .env.local holds a paid-service key; this script ignores it"
fi

export ELEVENLABS_API_KEY=
export TEXT_MODEL=none
export SELECTION_MODEL=off
export REFRESH_INTERVAL_MINUTES=0
export EMAIL_SOURCE_QUERY=
export GOOGLE_REFRESH_TOKEN=
export GIT_AUTO_PUSH=0
export PUBLIC_BASE_URL=http://127.0.0.1:8080
export DATA_DIR="${DATA_DIR:-$PWD/data}"
mkdir -p "$DATA_DIR"

echo "==> local server, paid services off, data in $DATA_DIR"
exec corepack pnpm@9 --dir server dev
