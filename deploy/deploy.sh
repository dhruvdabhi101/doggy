#!/usr/bin/env bash
# Pull latest main, rebuild, restart. Run on the VPS as root:  /srv/doggy/deploy/deploy.sh
set -euo pipefail
APP=/srv/doggy
BUN=/opt/bun/bin/bun
cd "$APP"
sudo -u doggy git pull --ff-only
cd "$APP/server" && sudo -u doggy "$BUN" install --frozen-lockfile
cd "$APP/web" && sudo -u doggy "$BUN" install --frozen-lockfile && sudo -u doggy "$BUN" run build
systemctl restart doggy
sleep 2
curl -fsS http://127.0.0.1:8787/api/health && echo " <- deployed $(git -C "$APP" rev-parse --short HEAD)"
