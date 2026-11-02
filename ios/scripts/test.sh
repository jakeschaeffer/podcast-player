#!/bin/bash
# Run every package's tests on macOS (seconds, no simulator). The decode and golden tests read
# ../contracts/ by path, so a server change that breaks the app fails here.
set -euo pipefail
cd "$(dirname "$0")/../Packages"
for pkg in PodcastAPI PlayerKit SyncKit; do
  echo "==> $pkg"
  swift test --package-path "$pkg" 2>&1 | grep -E "error:|✘|Test run with"
done
