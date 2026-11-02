#!/usr/bin/env bash
# Deploy origin/master to production. Run it from a machine that can ssh to the server (deploy/local.env names the
# host); it runs itself there as the user that owns the checkout and the service (deploy/README.md).
#   deploy/deploy.sh             # deploy
#   deploy/deploy.sh --check     # report drift and what a deploy would change; touch nothing
#   deploy/deploy.sh --restart   # restart the service even when no server file changed
#   deploy/deploy.sh --force     # restart without waiting for running jobs (a killed transcription is billed again)
#
# On the server, in order:
#   1. refuse if tracked files are edited in the checkout (code is changed on a branch and merged, never on the box);
#   2. back up the database to data/backups/;
#   3. reconcile the server's own commits (the Prompts screen and eval scorecards commit to master there): rebase
#      them onto origin/master and push, so GitHub holds them and the checkout equals origin/master;
#   4. install dependencies if the lockfile changed, rebuild the web app if web/ changed;
#   5. if the server changed, wait for running jobs, restart, and check /v1/health. Migrations run on start.
set -euo pipefail

say() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Where production lives: deploy/local.env (gitignored; copy local.env.example) names the ssh host, and may change the
# user and checkout from the worked example in deploy/README.md. Piped over ssh, the values travel in the environment.
here=$(cd "$(dirname "$0")" && pwd)
[ ! -f "$here/local.env" ] || . "$here/local.env"
HOST=${DEPLOY_HOST:-}
DEPLOY_USER=${DEPLOY_USER:-snip}
REPO=${DEPLOY_REPO:-/home/snip/repos/podcast-player}

if [ ! -d "$REPO/.git" ]; then
  [ -n "$HOST" ] || die "set DEPLOY_HOST in deploy/local.env (copy deploy/local.env.example), or run this on the server"
  exec ssh "$HOST" "DEPLOY_USER=$DEPLOY_USER DEPLOY_REPO=$REPO bash -s -- $*" < "$0"
fi

check=false restart=false force=false
for arg in "$@"; do
  case "$arg" in
    --check) check=true ;;
    --restart) restart=true ;;
    --force) force=true ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

cd "$REPO"

# The checkout and the service belong to one user. Run as root this would leave root-owned files behind.
[ "$(id -un)" = "$DEPLOY_USER" ] || die "run this as $DEPLOY_USER, not $(id -un)"
[ "$(git symbolic-ref --short HEAD)" = master ] || die "$REPO is on $(git symbolic-ref --short HEAD), not master"
dirty=$(git status --porcelain --untracked-files=no)
[ -z "$dirty" ] || die "tracked files are edited in $REPO. Move the change to a branch and a PR, or discard it:
$dirty"

git fetch -q origin master
prev=$(git rev-parse HEAD)
ahead=$(git rev-list --count origin/master..HEAD)
behind=$(git rev-list --count HEAD..origin/master)
say "server is $ahead ahead and $behind behind origin/master"
if [ "$ahead" -gt 0 ]; then
  git log --format='    server: %h %s' origin/master..HEAD
  # The server only ever commits prompt versions, the registry, and eval scorecards. Anything else was edited by
  # hand (or by a session) on the box and needs a person to look at it.
  stray=$(git diff --name-only origin/master...HEAD | grep -Ev '^(server/prompts/|evals/[^/]+/results/)' || true)
  [ -z "$stray" ] || die "the server's own commits touch files outside server/prompts and evals/*/results:
$stray
Push them to a branch and open a PR instead (git push origin HEAD:refs/heads/server-drift)."
fi
if [ "$behind" -gt 0 ]; then
  git log --format='    origin: %h %s' HEAD..origin/master
fi

if $check; then
  [ "$behind" -eq 0 ] || git diff --stat HEAD...origin/master | tail -1
  exit 0
fi

if [ "$ahead" -eq 0 ] && [ "$behind" -eq 0 ] && ! $restart; then
  say "nothing to deploy: $(git log -1 --format='%h %s')"
  exit 0
fi

mkdir -p data/backups
backup="data/backups/app-$(date -u +%Y%m%dT%H%M%SZ)-pre-deploy-$(git rev-parse --short origin/master).db"
say "backing up the database to $backup"
# An online backup through SQLite itself, so the copy is consistent while the service keeps writing.
(cd server && node -e '
  const Database = require("better-sqlite3");
  const db = new Database(process.argv[1], { readonly: true, fileMustExist: true });
  db.backup(process.argv[2]).then(() => db.close(), (e) => { console.error(e); process.exit(1); });
' "$REPO/data/app.db" "$REPO/$backup")

if [ "$ahead" -gt 0 ]; then
  if [ "$behind" -gt 0 ]; then
    say "rebasing the server's $ahead commit(s) onto origin/master"
    git rebase -q origin/master || { git rebase --abort; die "the server's commits conflict with origin/master; resolve them on a branch"; }
  fi
  say "pushing the server's commits to origin/master"
  git push -q origin HEAD:refs/heads/master
else
  git merge -q --ff-only origin/master
fi
now=$(git rev-parse HEAD)

changed=$(git diff --name-only "$prev" "$now")
if grep -qE '^(pnpm-lock\.yaml|package\.json|pnpm-workspace\.yaml|server/package\.json|web/package\.json)$' <<<"$changed"; then
  say "installing dependencies"
  pnpm install --frozen-lockfile --reporter=silent
fi
if grep -q '^web/' <<<"$changed"; then
  say "publishing the web app"
  deploy/publish-web.sh
fi
# Prompts are read from disk on every model call, so a prompt-only change needs no restart.
if grep -E '^(server/|pnpm-lock\.yaml|package\.json)' <<<"$changed" | grep -qv '^server/prompts/'; then
  restart=true
fi
if grep -q '^deploy/\(systemd\|nginx\|cloudflared\)/' <<<"$changed"; then
  say "note: files under deploy/systemd, deploy/nginx or deploy/cloudflared changed; install them by hand (deploy/README.md)"
fi

if $restart; then
  # The unit gives the process 30 s to stop, and a job killed mid-call is claimed again after its lease, so a
  # running transcription would be billed twice. Wait for running jobs to finish first.
  running_jobs() {
    (cd server && node -e '
      const Database = require("better-sqlite3");
      const db = new Database(process.argv[1], { readonly: true });
      const rows = db.prepare("SELECT kind, COUNT(*) AS n FROM job WHERE status = ? AND locked_until > ? GROUP BY kind").all("running", Date.now());
      console.log(rows.map((r) => `${r.kind} x${r.n}`).join(", "));
    ' "$REPO/data/app.db")
  }
  if ! $force; then
    for i in $(seq 1 60); do
      jobs=$(running_jobs)
      [ -z "$jobs" ] && break
      [ "$i" -eq 60 ] && die "jobs still running after 10 minutes ($jobs). The code is deployed but not restarted; rerun with --restart, or --force"
      say "waiting for running jobs: $jobs"
      sleep 10
    done
  fi
  say "restarting podcast-player"
  # The one thing snip may do as root (deploy/sudoers/snip-podcast-player).
  sudo -n systemctl restart podcast-player
  ok=false
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null http://127.0.0.1:8080/v1/health 2>/dev/null && curl -fsS -o /dev/null http://127.0.0.1:4350/v1/health 2>/dev/null; then ok=true; break; fi
    sleep 1
  done
  if ! $ok; then
    journalctl -u podcast-player -n 40 --no-pager >&2 || true
    die "the server is not healthy after restart. Previous code: $prev, database backup: $backup"
  fi
  say "healthy"
fi

say "deployed $(git log -1 --format='%h %s')"
