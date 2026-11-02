#!/usr/bin/env bash
# Copy production's database and audio into the local data folder, for testing with scripts/dev-server.sh.
#   scripts/dev-snapshot.sh             # database and media (about 1 GB the first time, then only what changed)
#   scripts/dev-snapshot.sh --db-only   # database only; episodes whose audio isn't copied won't play
# The copy is safe to poke at: the local APP_SECRET differs from production's, so stored feed and enclosure URLs
# can't be decrypted and the local server never fetches a feed or a recording, and dev-server.sh keeps every paid
# service off. Device tokens are copied as they are, so a token that works on production works locally too.
set -euo pipefail
cd "$(dirname "$0")/.."

# Production's host and checkout come from deploy/local.env (deploy/local.env.example).
[ ! -f deploy/local.env ] || . deploy/local.env
HOST=${DEPLOY_HOST:-}
REMOTE=${DEPLOY_REPO:-/home/snip/repos/podcast-player}
[ -n "$HOST" ] || { echo "error: set DEPLOY_HOST in deploy/local.env (copy deploy/local.env.example)" >&2; exit 1; }
DATA_DIR="${DATA_DIR:-$PWD/data}"

if curl -fsS -o /dev/null http://127.0.0.1:8080/v1/health 2>/dev/null; then
  echo "error: a server is running on 127.0.0.1:8080; stop it before replacing its database" >&2
  exit 1
fi
mkdir -p "$DATA_DIR/media"

tmp="/tmp/pp-snapshot-$$.db"
echo "==> snapshotting production's database"
ssh "$HOST" "cd $REMOTE/server && node -e '
  const Database = require(\"better-sqlite3\");
  const db = new Database(\"$REMOTE/data/app.db\", { readonly: true, fileMustExist: true });
  db.backup(\"$tmp\").then(() => db.close(), (e) => { console.error(e); process.exit(1); });
'"
rm -f "$DATA_DIR/app.db-wal" "$DATA_DIR/app.db-shm"
scp -q "$HOST:$tmp" "$DATA_DIR/app.db"
ssh "$HOST" "rm -f $tmp"
echo "    $(du -h "$DATA_DIR/app.db" | cut -f1) database in $DATA_DIR"
# Recordings and clips are stored by absolute path; point them at the local copy.
(cd server && node -e '
  const Database = require("better-sqlite3");
  const db = new Database(process.argv[1]);
  const [from, to] = [process.argv[2], process.argv[3]];
  const a = db.prepare("UPDATE audio_asset SET path = ? || substr(path, ?) WHERE path LIKE ?").run(to, from.length + 1, `${from}%`).changes;
  const c = db.prepare("UPDATE snip_revision SET clip_path = ? || substr(clip_path, ?) WHERE clip_path LIKE ?").run(to, from.length + 1, `${from}%`).changes;
  console.log(`    repointed ${a} recordings and ${c} clips`);
' "$DATA_DIR/app.db" "$REMOTE/data/" "$DATA_DIR/")

if [ "${1:-}" != "--db-only" ]; then
  echo "==> copying media"
  rsync -a --info=stats0 "$HOST:$REMOTE/data/media/" "$DATA_DIR/media/" 2>/dev/null || rsync -a "$HOST:$REMOTE/data/media/" "$DATA_DIR/media/"
  echo "    $(du -sh "$DATA_DIR/media" | cut -f1) media"
fi
echo "OK: start it with scripts/dev-server.sh"
