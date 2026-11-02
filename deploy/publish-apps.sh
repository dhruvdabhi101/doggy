#!/usr/bin/env bash
# Builds the Mac and Windows desktop apps and replaces the files the website serves.
# Run from a Mac with Swift and the .NET SDK:  deploy/publish-apps.sh root@<server> [extra ssh options]
# The site's download links carry the file's modification time, so a new upload is downloaded right away.
set -euo pipefail
TARGET="${1:?usage: publish-apps.sh user@host [ssh options]}"
shift
SSH_OPTS=("$@")
REPO="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_DIR=/var/lib/doggy/downloads

"$REPO/agents/mac/scripts/package.sh"
"$REPO/agents/windows/scripts/package.sh"

upload() {
  local src="$1" name
  name="$(basename "$src")"
  scp -q "${SSH_OPTS[@]}" "$src" "$TARGET:$REMOTE_DIR/.$name.part"
  ssh "${SSH_OPTS[@]}" "$TARGET" "chown doggy:doggy '$REMOTE_DIR/.$name.part' && chmod 644 '$REMOTE_DIR/.$name.part' && mv -f '$REMOTE_DIR/.$name.part' '$REMOTE_DIR/$name'"
  echo "published $name ($(du -h "$src" | cut -f1))"
}

upload "$REPO/dist/mac/Doggy-mac.dmg"
upload "$REPO/dist/windows/Doggy-windows.exe"
