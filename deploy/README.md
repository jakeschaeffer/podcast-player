# deploy

One working production setup, as a worked example of [docs/SELF-HOSTING.md](../docs/SELF-HOSTING.md): a small VPS where the podcast player is public at **https://snip.sch.xyz** through a Cloudflare tunnel. No port is open to the internet. The host's ssh alias, user and checkout live in the gitignored `deploy/local.env` (copy `local.env.example`); the paths below are that file's defaults.

```text
browser ──https──▶ Cloudflare ──tunnel "podcast-player"──▶ cloudflared ──▶ nginx 127.0.0.1:4350
                                                                              ├─ /v1 /m /s /e ──▶ server 127.0.0.1:8080
                                                                              └─ everything else ─▶ /var/www/podcast-player (web/dist)
```

| Piece | Runs as | Config in this folder | Installed at |
|---|---|---|---|
| Server (API and worker) | `podcast-player.service` as user `snip`, from `/home/snip/repos/podcast-player/server` | `systemd/podcast-player.service`, `sudoers/snip-podcast-player` | `/etc/systemd/system/`, `/etc/sudoers.d/` |
| Web app and proxy | nginx site on `127.0.0.1:4350` | `nginx/podcast-player.conf`, `nginx/podcast-player-proxy.conf` | `/etc/nginx/sites-available/` (linked from `sites-enabled/`), `/etc/nginx/snippets/` |
| Tunnel | `cloudflared-podcast-player.service`, user `cloudflared-podcast` | `cloudflared/podcast-player.yml`, `systemd/cloudflared-podcast-player.service` | `/etc/cloudflared/`, `/etc/systemd/system/` |
| DNS | proxied CNAME `snip.sch.xyz` → the tunnel | | Cloudflare |

The tunnel's credentials are in `/etc/cloudflared/podcast-player.json` (mode 640, group `cloudflared-podcast`) and are never committed; `cloudflared/podcast-player.yml` is committed with the tunnel id left as a placeholder. The server reads its secrets, `PUBLIC_BASE_URL=https://snip.sch.xyz` and `SHARE_BY_NAME` from `.env.server.local` at the repository root.

## Redeploy

The server runs the main checkout's working tree, owned by `snip`, so deploys follow `master` there. Deploy with one command, from the Mac (`DEPLOY_HOST` in `deploy/local.env` is an ssh alias that logs in as `snip`) or from the server as `snip`:

```bash
deploy/deploy.sh             # back up the database, sync with origin/master, install, rebuild, restart, check health
deploy/deploy.sh --check     # what a deploy would do, and whether the server has commits of its own
deploy/deploy.sh --restart   # also restart when no server file changed (after editing .env.server.local)
journalctl -u podcast-player -f        # server log
```

It refuses to run when tracked files in the checkout are edited: code changes go through a branch and a PR, never onto the box. It restarts only when something under `server/` (other than prompts) or the dependencies changed, and first waits up to ten minutes for running jobs, since a transcription killed by the restart is claimed again and billed twice. Changes to the files in `systemd/`, `nginx/` and `cloudflared/` are reported but installed by hand (below). If the health check fails it prints the log, the previous commit, and the backup's path; to roll back, `git reset --hard <previous>` in the checkout, restore the backup over `data/app.db` with the service stopped, and start it.

The app's Prompts screen writes to this checkout too: a new prompt version, an activation, and each eval run's scorecard are committed to the current branch (`master`) by the server itself, one small commit each, touching only those files. With `GIT_AUTO_PUSH=1` in `.env.server.local` each commit is pushed to GitHub right away with snip's deploy key (`/home/snip/.ssh/id_ed25519`, registered on the repository with write access; the remote is `git@github.com:jakeschaeffer/podcast-player.git`), so the server never holds the owner's GitHub login. A push that is rejected because `master` moved on stays local; the next `deploy/deploy.sh` rebases it onto `origin/master` and pushes it, and refuses if the server's own commits touch anything outside `server/prompts/` and `evals/*/results/`.

## Tailscale

The native app can't pass Cloudflare Access, so it reaches the same nginx over the tailnet: `tailscale serve --bg --https=8443 http://127.0.0.1:4350` serves `https://<machine>.<tailnet>.ts.net:8443` to tailnet devices only, with a certificate the phone trusts. `tailscale serve status` shows it; `tailscale serve --https=8443 off` undoes it. That address is what the owner's `ios/Config/Local.xcconfig` names as `PODCAST_SERVER_URL`, and the phone needs Tailscale on. The alternatives are an Access bypass for `/v1` and `/m` (the server's own device-token login and lockout were hardened for that) or an Access service token sent by the app; both are dashboard changes.

`pnpm --dir server dev` no longer works while the service runs, since both want port 8080. Stop the service first (`sudo systemctl stop podcast-player`; starting, stopping and restarting this one unit is all `snip` may do as root) to run the server by hand. The Vite dev server is unaffected: it still proxies to 8080, including over the tailnet.

## What the proxy adds

- **One origin.** The login cookie, signed media URLs, and public pages all live beside the app, as `web/README.md` requires.
- **No edge caching of the server's responses.** Every proxied response carries `Cloudflare-CDN-Cache-Control: no-store`. Public clip audio is sent with a year-long browser cache, and Cloudflare caches `.mp3` by default, so without this a revoked or deleted snip's audio would keep serving from the edge.
- **Login rate limit.** `POST /v1/devices` takes 6 attempts a minute per visitor, with a burst of 5, then answers 429. The visitor is `CF-Connecting-IP`, since every request reaches nginx from 127.0.0.1.
- **https as seen by the server.** nginx sends `X-Forwarded-Proto: https`, so the login cookie is `Secure` here and stays non-Secure on the plain-http dev server.
- **Caching for the app itself.** Hashed files in `/assets/` are immutable; the shell, service worker, and manifest are rechecked on every visit.

## Install from scratch

The checkout is `/home/snip/repos/podcast-player`, owned by `snip`, who also runs the service; root is needed only where marked. The tunnel was created once with `cloudflared tunnel create podcast-player`, which printed its id and wrote its credentials to `/root/.cloudflared/<tunnel id>.json`; put the id in `/etc/cloudflared/podcast-player.yml`.

```bash
# the snip user (root, once)
useradd -m -s /bin/bash -c "podcast-player service and deploy user" snip
usermod -aG systemd-journal,adm snip                       # read the journal and nginx logs
install -m 440 deploy/sudoers/snip-podcast-player /etc/sudoers.d/snip-podcast-player && visudo -c
install -d -m 700 -o snip -g snip /home/snip/.ssh         # then the Mac's public key into /home/snip/.ssh/authorized_keys
install -d -o snip -g snip /var/www/podcast-player         # publish-web.sh writes here; nginx only reads
# as snip: `ssh-keygen -t ed25519` and register ~/.ssh/id_ed25519.pub as a deploy key with write access
# (repository Settings → Deploy keys); `corepack install -g pnpm@<the version root uses>`; the Codex CLI binary in
# ~/.local/bin with auth.json and a config.toml in ~/.codex (copied from a logged-in install); then
git clone git@github.com:jakeschaeffer/podcast-player.git ~/repos/podcast-player && cd ~/repos/podcast-player && pnpm install
# Never chown a checkout that root installed: its node_modules are hard links into root's pnpm store, shared with
# root's other projects, so the chown hands snip files that root runs. Delete node_modules and install as snip.
# .env.local and .env.server.local at the repository root, mode 600; DATA_DIR=/home/snip/repos/podcast-player/data

# web app (snip)
deploy/publish-web.sh

# nginx (root)
cp deploy/nginx/podcast-player.conf /etc/nginx/sites-available/podcast-player
cp deploy/nginx/podcast-player-proxy.conf /etc/nginx/snippets/podcast-player-proxy.conf
ln -s /etc/nginx/sites-available/podcast-player /etc/nginx/sites-enabled/podcast-player
nginx -t && systemctl reload nginx

# server (root)
cp deploy/systemd/podcast-player.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now podcast-player

# tunnel (root)
useradd --system --no-create-home --shell /usr/sbin/nologin cloudflared-podcast
install -m 640 -o root -g cloudflared-podcast /root/.cloudflared/<tunnel id>.json /etc/cloudflared/podcast-player.json
sed "s/<tunnel id>.*/<tunnel id>/" deploy/cloudflared/podcast-player.yml > /etc/cloudflared/podcast-player.yml   # with the real id
cp deploy/systemd/cloudflared-podcast-player.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now cloudflared-podcast-player
# --config matters: without it cloudflared reads /root/.cloudflared/config.yml and routes to that tunnel instead
cloudflared tunnel --config /etc/cloudflared/podcast-player.yml --origincert /root/.cloudflared/cert.pem \
  route dns --overwrite-dns <tunnel id> snip.sch.xyz
```

## Cloudflare Access

The owner's app is meant to sit behind Cloudflare Access with the owner's Google account, while shared snip and episode pages stay public. Access lives in the Cloudflare Zero Trust dashboard, not in this repository:

1. **Login method.** Under Settings → Authentication, Google (or Google Workspace for sch.xyz) must be listed.
2. **The app.** Access → Applications → Add an application → Self-hosted, named "Podcast player". Domain `snip.sch.xyz` with no path, session duration 1 month. Policy "Owner": action Allow, include Emails `<your address>`. Allow only the Google login method, with instant auth on.
3. **Public pages.** A second self-hosted application, "Podcast player public pages", with two domains: `snip.sch.xyz` path `s`, and `snip.sch.xyz` path `e`. Policy "Public": action Bypass, include Everyone. The more specific paths take precedence, so shared links open without a login.

The owner password stays as a second step inside the app. The local e2e run is unaffected, since it goes through Vite on 5174 to 127.0.0.1:8080. When the Access session ends, the app's requests fail as "No connection" until the page is reloaded and the Google login completes.
