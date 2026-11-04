#!/usr/bin/env bash
# Idempotent server setup + deploy. Run by the GitHub "Deploy" workflow over SSH
# (or by hand) from the app directory on an Ubuntu 22.04/24.04 server.
#   OWNER_EMAIL   — the only email allowed to sign up
#   SITE_ADDRESS  — optional domain; defaults to <public-ip>.sslip.io
set -euo pipefail
cd "$(dirname "$0")"

log() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }

# 1) Docker
if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker"
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "${USER:-ubuntu}" || true
fi
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"

# 2) Firewall: Oracle's Ubuntu images block 80/443 in iptables by default.
if command -v iptables >/dev/null 2>&1 && sudo iptables -S INPUT 2>/dev/null | grep -q "REJECT"; then
  for port in 80 443; do
    sudo iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null \
      || sudo iptables -I INPUT 5 -p tcp --dport "$port" -m state --state NEW -j ACCEPT
  done
  if command -v netfilter-persistent >/dev/null 2>&1; then sudo netfilter-persistent save >/dev/null; fi
fi

# 3) Swap (helps the first build on small servers)
if [ "$(swapon --show | wc -l)" -eq 0 ] && [ ! -f /swapfile ]; then
  log "Adding 2 GB swap"
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# 4) Secrets — generated once, on the server, never leave it.
if [ ! -f .env ]; then
  log "Creating deploy/.env with fresh secrets"
  IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
  SITE="${SITE_ADDRESS:-$IP.sslip.io}"
  umask 077
  cat > .env <<ENV
SITE_ADDRESS=$SITE
APP_URL=https://$SITE
POSTGRES_PASSWORD=$(openssl rand -hex 24)
APP_ENCRYPTION_KEY=$(openssl rand -base64 32)
APP_HASH_KEY=$(openssl rand -hex 32)
SIGNUP_MODE=closed
SIGNUP_ALLOWLIST=${OWNER_EMAIL:-}
ADMIN_EMAIL=${OWNER_EMAIL:-}
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5-mini
RESEND_API_KEY=
MAIL_FROM=
ENV
fi

# Keep the allow-list in sync if the owner email is provided later.
if [ -n "${OWNER_EMAIL:-}" ] && ! grep -q "^SIGNUP_ALLOWLIST=.\+" .env; then
  sed -i "s|^SIGNUP_ALLOWLIST=.*|SIGNUP_ALLOWLIST=$OWNER_EMAIL|; s|^ADMIN_EMAIL=.*|ADMIN_EMAIL=$OWNER_EMAIL|" .env
fi
# OpenAI key can be supplied from GitHub secrets without ever being written to the repo.
if [ -n "${OPENAI_API_KEY:-}" ]; then
  sed -i "s|^OPENAI_API_KEY=.*|OPENAI_API_KEY=$OPENAI_API_KEY|" .env
fi

# 5) Build and (re)start
log "Building and starting containers"
$DOCKER compose --env-file .env up -d --build --remove-orphans
$DOCKER image prune -f >/dev/null

# 6) Restart Caddy so a certificate that failed earlier (e.g. ports opened late) is retried now.
mkdir -p diag
$DOCKER compose --env-file .env restart caddy >/dev/null 2>&1 || true

write_diag() {
  {
    echo "# CareerFlow status — $(date -u '+%F %T UTC')"
    echo "commit: $(git -C .. rev-parse --short HEAD 2>/dev/null || echo unknown)"
    echo "site:   https://$(grep ^SITE_ADDRESS= .env | cut -d= -f2)"
    echo; echo "## containers"; $DOCKER compose --env-file .env ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}' 2>&1
    echo; echo "## app health (inside server)"; $DOCKER compose --env-file .env exec -T web curl -s http://localhost:3000/api/health 2>&1 || echo "web not answering"
    echo; echo "## firewall INPUT"; sudo iptables -S INPUT 2>&1 | head -20
    echo; echo "## caddy (https certificate)"; $DOCKER compose --env-file .env logs --no-color --tail 40 caddy 2>&1 | cut -c1-400
    echo; echo "## migrate"; $DOCKER compose --env-file .env logs --no-color --tail 15 migrate 2>&1 | cut -c1-300
    echo; echo "## worker"; $DOCKER compose --env-file .env logs --no-color --tail 15 worker 2>&1 | cut -c1-300
  } > diag/status.txt
}

# 7) Wait for health
SITE=$(grep ^SITE_ADDRESS= .env | cut -d= -f2)
for i in $(seq 1 60); do
  if $DOCKER compose --env-file .env exec -T web curl -sf http://localhost:3000/api/health >/dev/null 2>&1; then
    sleep 20; write_diag
    log "Healthy. Open: https://$SITE"
    exit 0
  fi
  sleep 5
done
write_diag
echo "App did not become healthy in time. See http://<server-ip>/_diag/status.txt"
exit 1
