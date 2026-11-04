#!/bin/bash
# Paste this whole file into Oracle "Create instance" → Advanced options →
# Management → "Paste cloud-init script". It runs once, as root, on first boot:
# installs Docker, downloads the app, starts it, and checks GitHub every 5 minutes
# for updates. No SSH keys or GitHub secrets needed.
set -euxo pipefail
OWNER_EMAIL="mohamedshereef28@gmail.com"
REPO="https://github.com/MohamedShereef/Career-flow-ai.git"
APP=/opt/careerflow

export DEBIAN_FRONTEND=noninteractive
apt-get update -y && apt-get install -y git curl openssl
command -v docker || curl -fsSL https://get.docker.com | sh
[ -d "$APP/.git" ] || git clone --depth 1 "$REPO" "$APP"

cat > /etc/careerflow.env <<ENV
OWNER_EMAIL=$OWNER_EMAIL
ENV

cat > /usr/local/bin/careerflow-update <<'SH'
#!/bin/bash
# Pull the latest main and redeploy only when it changed.
set -euo pipefail
exec 9>/var/lock/careerflow-update.lock
flock -n 9 || exit 0   # another update is already running
set -a; . /etc/careerflow.env; set +a
cd /opt/careerflow
git fetch --depth 1 origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ] || [ ! -f deploy/.env ] || [ "${1:-}" = "--force" ]; then
  git reset --hard origin/main
  USER=root bash deploy/bootstrap.sh
fi
SH
chmod +x /usr/local/bin/careerflow-update

cat > /etc/systemd/system/careerflow-update.service <<'UNIT'
[Unit]
Description=CareerFlow update and deploy
After=network-online.target docker.service
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/careerflow-update
UNIT
cat > /etc/systemd/system/careerflow-update.timer <<'UNIT'
[Unit]
Description=Check for CareerFlow updates every 5 minutes
[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now careerflow-update.timer
/usr/local/bin/careerflow-update --force
