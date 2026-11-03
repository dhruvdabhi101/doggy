#!/usr/bin/env bash
# Snapshot the database, build, restart. A failed health check or a dropped
# user/item/note count returns the server tree to the previous commit.
# The snapshot file stays. Run on the VPS as root: /srv/doggy/deploy/deploy.sh
set -euo pipefail
APP=/srv/doggy
BUN=/opt/bun/bin/bun
DB=/var/lib/doggy/doggy.db
BACKUP_DIR=/var/lib/doggy/backups
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

cd "$APP"
sudo -u doggy git checkout main
PREV=$(sudo -u doggy git -C "$APP" rev-parse HEAD)
sudo -u doggy git pull --ff-only

install -d -o doggy -g doggy -m 750 "$BACKUP_DIR"
SNAP="$BACKUP_DIR/pre-deploy-$STAMP.db"
sudo -u doggy "$BUN" "$APP/server/scripts/backup.ts" "$DB" "$SNAP"
echo "snapshot $SNAP"

if ! (cd "$APP/server" && sudo -u doggy "$BUN" install --frozen-lockfile); then
  echo "server install failed; leaving the running process on $PREV" >&2
  exit 1
fi
if ! (cd "$APP/web" && sudo -u doggy "$BUN" install --frozen-lockfile && sudo -u doggy "$BUN" run build); then
  echo "web build failed; leaving the running process on $PREV" >&2
  exit 1
fi

install -m 644 "$APP/deploy/doggy-backup.service" /etc/systemd/system/doggy-backup.service
install -m 644 "$APP/deploy/doggy-backup.timer" /etc/systemd/system/doggy-backup.timer
systemctl daemon-reload
systemctl enable --now doggy-backup.timer

mapfile -t old < <(ls -1t "$BACKUP_DIR"/pre-deploy-*.db 2>/dev/null | tail -n +21 || true)
if ((${#old[@]})); then rm -f "${old[@]}"; fi

rollback() {
  echo "deploy failed, returning the tree to $PREV" >&2
  sudo -u doggy git -C "$APP" reset --hard "$PREV"
  cd "$APP/server" && sudo -u doggy "$BUN" install --frozen-lockfile
  cd "$APP/web" && sudo -u doggy "$BUN" install --frozen-lockfile && sudo -u doggy "$BUN" run build
  systemctl restart doggy
  exit 1
}

systemctl restart doggy
sleep 2
curl -fsS http://127.0.0.1:8787/api/health || rollback
sudo -u doggy "$BUN" "$APP/server/scripts/backup.ts" --expect "$DB" "$SNAP.json" || rollback
echo "deployed $(sudo -u doggy git -C "$APP" rev-parse --short HEAD)"
