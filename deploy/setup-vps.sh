#!/usr/bin/env bash
# One-time VPS setup (Debian). Run as root. Idempotent.
set -euo pipefail
id doggy >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/doggy --shell /usr/sbin/nologin doggy
mkdir -p /var/lib/doggy/downloads /etc/doggy
chown -R doggy:doggy /var/lib/doggy
if [ ! -x /opt/bun/bin/bun ]; then
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash
fi
[ -d /srv/doggy/.git ] || git clone https://github.com/dhruvdabhi101/doggy.git /srv/doggy
chown -R doggy:doggy /srv/doggy
install -m 644 /srv/doggy/deploy/doggy.service /etc/systemd/system/doggy.service
install -m 644 /srv/doggy/deploy/doggy.caddy /etc/caddy/doggy.caddy
touch /etc/doggy/doggy.env && chown root:doggy /etc/doggy/doggy.env && chmod 640 /etc/doggy/doggy.env
systemctl daemon-reload
systemctl enable doggy
