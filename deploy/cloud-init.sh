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
# Docker: official script first; if it refuses this Ubuntu version, add Docker's apt
# repository directly; last resort, Ubuntu's own packages.
install_docker() {
  if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then return 0; fi
  if curl -fsSL https://get.docker.com | sh && docker compose version >/dev/null 2>&1; then return 0; fi
  echo "get.docker.com failed; trying Docker apt repo"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release; echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  if apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; then return 0; fi
  echo "Docker repo failed; falling back to Ubuntu packages"
  rm -f /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker.io docker-compose-v2 docker-buildx || apt-get install -y docker.io docker-compose-v2
}
install_docker
systemctl enable --now docker
docker compose version
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
