#!/usr/bin/env bash
# Build the web client from this checkout and publish it where nginx serves snip.sch.xyz.
# Old hashed assets are kept, so a page loaded before the deploy can still fetch its files.
set -euo pipefail
cd "$(dirname "$0")/.."
target=/var/www/podcast-player
pnpm --dir web build
mkdir -p "$target"
# Assets first, then the shell that points at them.
rsync -a web/dist/assets/ "$target/assets/"
rsync -a --exclude assets/ web/dist/ "$target/"
echo "published $(git rev-parse --short HEAD) to $target"
