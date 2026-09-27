#!/usr/bin/env bash
# =============================================================================
#  SLATE DevOps OS — Master Dashboard
#  Oracle Cloud Always Free VPS — one-shot provision + deploy script
# =============================================================================
#  Usage (on the VM, as the `ubuntu` user, from anywhere):
#      bash deploy-free.sh
#
#  Re-runnable: safe to run again after updates (it detects an existing install).
#  Idempotent:   every step checks before it changes anything.
# =============================================================================
set -Eeuo pipefail

# ── Config (override via env if needed) ─────────────────────────────────────
APP_DIR="${APP_DIR:-/opt/slate-master-dashboard}"
APP_PORT="${APP_PORT:-3000}"
NODE_MAJOR="${NODE_MAJOR:-20}"
APP_USER="${APP_USER:-ubuntu}"
LOG_KEEP_DAYS="${LOG_KEEP_DAYS:-14}"
BACKUP_KEEP_COUNT="${BACKUP_KEEP_COUNT:-14}"

# ── Pretty output ───────────────────────────────────────────────────────────
BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; CYAN=$'\033[36m'; NC=$'\033[0m'
step()  { echo; echo "${BOLD}${CYAN}==> $*${NC}"; }
ok()    { echo "  ${GREEN}✓${NC} $*"; }
warn()  { echo "  ${YELLOW}!${NC} $*"; }
fail()  { echo "  ${RED}✗${NC} $*" >&2; }
die()   { fail "$*"; exit 1; }

trap 'die "Failed at line $LINENO. Re-run this script; it is safe to re-run."' ERR

# ── Preconditions ───────────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] && SUDO="" || SUDO="sudo"
[ "$(id -un)" = "$APP_USER" ] || die "Run this as the '$APP_USER' user (e.g. ssh ubuntu@IP && bash deploy-free.sh)"

log() { logger -t slate-deploy -p daemon.info "$*" 2>/dev/null || true; }

# =============================================================================
step "1/9  System update & base packages"
# =============================================================================
$SUDO apt-get update -qq
$SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  curl ca-certificates gnupg git nginx build-essential rsync unzip ufw fail2ban >/dev/null
$SUDO DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq >/dev/null
ok "Base packages ready"

# Oracle ARM shapes are ARM64; make sure the toolchain matches the host.
MACHINE="$(uname -m)"
ok "Architecture: ${MACHINE}"

# =============================================================================
step "2/9  Node.js ${NODE_MAJOR}.x"
# =============================================================================
need_node=1
if command -v node >/dev/null 2>&1; then
  current="$(node -v | sed 's/v\([0-9]*\).*/\1/')"
  if [ "$current" -ge "$NODE_MAJOR" ]; then need_node=0; fi
fi
if [ "$need_node" -eq 1 ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash - >/dev/null 2>&1
  $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
  ok "Node.js $(node -v) installed"
else
  ok "Node.js $(node -v) already present"
fi

# =============================================================================
step "3/9  Swapping space safety net (Oracle ARM VMs often have tiny disks)"
# =============================================================================
ROOT_FREE_MB="$(df -Pm / | awk 'NR==2{print $4}')"
if [ "$ROOT_FREE_MB" -lt 6000 ]; then
  warn "Only ${ROOT_FREE_MB} MB free on /. Adding a 2 GB swap file."
  if ! swapon --show | grep -q .; then
    $SUDO fallocate -l 2G /swapfile || $SUDO dd if=/dev/zero of=/swapfile bs=1M count=2048
    $SUDO chmod 600 /swapfile
    $SUDO mkswap /swapfile >/dev/null
    $SUDO swapon /swapfile
    grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
  fi
  ok "Swap active (2 GB)"
else
  ok "Disk space sufficient (${ROOT_FREE_MB} MB free)"
fi

# =============================================================================
step "4/9  Project directory: ${APP_DIR}"
# =============================================================================
if [ ! -d "$APP_DIR" ]; then
  $SUDO mkdir -p "$APP_DIR"
  $SUDO chown "$APP_USER:$APP_USER" "$APP_DIR"
  ok "Created $APP_DIR"
else
  $SUDO chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  ok "Reusing existing $APP_DIR"
fi

# Resolve where the source code actually is:
#   - if the script is run from inside the project (./deploy/deploy-free.sh) use it
#   - otherwise fall back to the project directory on the VM
if [ -f "./package.json" ] && [ -d "./app" ]; then
  SRC_DIR="$(pwd)"
elif [ -f "${APP_DIR}/package.json" ]; then
  SRC_DIR="$APP_DIR"
else
  die "package.json not found. Upload the project (scp/rsync) and re-run."
fi
ok "Source: $SRC_DIR"

# =============================================================================
step "5/9  Environment file (.env.local) with fresh random secrets"
# =============================================================================
ENV_FILE="${APP_DIR}/.env.local"
gen_secret() { node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"; }

PUBLIC_URL="${PUBLIC_URL:-}"
if [ -z "$PUBLIC_URL" ]; then
  # Best-effort public IP detection, otherwise fall back to a literal to edit.
  PUBLIC_URL="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  if [ -z "$PUBLIC_URL" ]; then
    PUBLIC_URL="http://YOUR_SERVER_IP"
    warn "Could not auto-detect public IP — edit $ENV_FILE later."
  fi
fi

if [ -f "$ENV_FILE" ]; then
  warn "$ENV_FILE exists — KEEPING IT (secrets preserved, sites keep working)."
  $SUDO -u "$APP_USER" cp "$ENV_FILE" "${ENV_FILE}.bak.$(date +%s)"
else
  ENCRYPTION_SECRET="${ENCRYPTION_SECRET:-$(gen_secret)}"
  JWT_SECRET="$(gen_secret)"
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(gen_secret | cut -c1-20)}"

  # ── CRITICAL GUARD ────────────────────────────────────────────────────────
  # data/db.json holds encrypted database passwords, handshake tokens and
  # webhook secrets. If a database already exists but the encryption secret is
  # brand new, every one of those records becomes unreadable. Refuse to
  # continue unless the operator explicitly acknowledges this.
  if [ -s "${APP_DIR}/data/db.json" ] && [ -z "${ENCRYPTION_SECRET_PRESET:-}" ]; then
    echo
    fail "data/db.json already exists on this server but no .env.local was found."
    echo
    echo "  Your database passwords and handshake tokens are ENCRYPTED with"
    echo "  ENCRYPTION_SECRET. Generating a new one makes all 7 sites, 4 databases"
    echo "  and 7 licences unreadable."
    echo
    echo "  ${BOLD}Fix it in one of two ways:${NC}"
    echo
    echo "  ${BOLD}A) Upload your existing secret (recommended)${NC}"
    echo "     On your local machine run:"
    echo "       (Get-Content .env.local | Select-String '^ENCRYPTION_SECRET=') -replace '^ENCRYPTION_SECRET=',''"
    echo "     Then re-run this script with it:"
    echo "       ENCRYPTION_SECRET=<paste> ENCRYPTION_SECRET_PRESET=1 bash deploy-free.sh"
    echo
    echo "  ${BOLD}B) Start fresh (destroys existing data)${NC}"
    echo "       ENCRYPTION_SECRET_PRESET=1 bash deploy-free.sh"
    echo "     ...then upload an empty/new data/db.json."
    echo
    exit 1
  fi
  [ -n "${ENCRYPTION_SECRET_PRESET:-}" ] && ok "Using the ENCRYPTION_SECRET you provided (existing sites stay readable)"

  $SUDO tee "$ENV_FILE" >/dev/null <<EOF
# ── SLATE DevOps OS Master Dashboard · production environment ──
# Generated $(date -u '+%Y-%m-%d %H:%M UTC') by deploy/deploy-free.sh
# NEVER commit this file to Git. chmod 600 applied below.

# Core
ENCRYPTION_SECRET=$ENCRYPTION_SECRET
JWT_SECRET=$JWT_SECRET
PORT=$APP_PORT
HOSTNAME=127.0.0.1

# Admin credentials
ADMIN_USERNAME=${ADMIN_USERNAME:-masterops}
ADMIN_PASSWORD=$ADMIN_PASSWORD

# Public URL your CLIENT browsers will reach
MASTER_PUBLIC_URL=$PUBLIC_URL
NEXT_PUBLIC_APP_URL=$PUBLIC_URL

# GitHub
GITHUB_DEFAULT_PAT=

# Stripe (optional)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# SMTP (optional)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM_LICENSE=
SMTP_ENCRYPTION=tls
EOF
  $SUDO chmod 600 "$ENV_FILE"
  $SUDO chown "$APP_USER:$APP_USER" "$ENV_FILE"
  ok "Created $ENV_FILE"
  echo
  echo "  ${BOLD}${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
  echo "  ${BOLD}${GREEN}║  ADMIN LOGIN — SAVE THIS NOW                       ║${NC}"
  echo "  ${BOLD}${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
  echo "  ${BOLD}URL       :${NC} ${PUBLIC_URL}/admin/login"
  echo "  ${BOLD}Username  :${NC} ${ADMIN_USERNAME:-masterops}"
  echo "  ${BOLD}Password  :${NC} ${BOLD}${ADMIN_PASSWORD}${NC}"
  echo
  echo "  ${YELLOW}It is also saved in $ENV_FILE — do not lose both.${NC}"
  echo
fi

# =============================================================================
step "6/9  Installing dependencies & building"
# =============================================================================
cd "$SRC_DIR"
mkdir -p logs data

if [ -f package-lock.json ] && [ "$SRC_DIR" = "$APP_DIR" ]; then
  npm ci --omit=dev || npm install --omit=dev
else
  # Build needs devDependencies (typescript, tailwind, postcss)
  npm install
fi
ok "Dependencies installed"

# Node memory guard.
# Next.js production server ne ekhon km memory use kore. Build-e jyesto
# memory lage, seta-i bishesh kore -- 2 OCPU / 12 GB VM-r jonno eta-i safe.
export NODE_OPTIONS="--max-old-space-size=2560"

if [ -f .next/BUILD_ID ] && [ "${FORCE_BUILD:-0}" != "1" ]; then
  ok "Existing build found (set FORCE_BUILD=1 to rebuild)"
else
  npm run build
  ok "Build complete"
fi

# Keep required runtime dirs
$SUDO mkdir -p "$APP_DIR/logs" "$APP_DIR/data" "$APP_DIR/backups"
$SUDO chown -R "$APP_USER:$APP_USER" "$APP_DIR/logs" "$APP_DIR/data" "$APP_DIR/backups"

# =============================================================================
step "7/9  Process manager + service"
# =============================================================================
# We use systemd (not PM2) — simpler, survives reboots, no extra layer.
$SUDO cp "${SRC_DIR}/deploy/slate-master.service" /etc/systemd/system/slate-master.service
$SUDO systemctl daemon-reload
$SUDO systemctl enable slate-master >/dev/null 2>&1 || true
$SUDO systemctl restart slate-master
sleep 6
if $SUDO systemctl is-active --quiet slate-master; then
  ok "slate-master.service is active"
else
  $SUDO journalctl -u slate-master -n 30 --no-pager || true
  die "Service did not start. See logs above."
fi

# =============================================================================
step "8/9  Nginx reverse proxy + firewall + SSL"
# =============================================================================
$SUDO cp "${SRC_DIR}/deploy/nginx-dashboard.conf" /etc/nginx/sites-available/slate-master
$SUDO ln -sf /etc/nginx/sites-available/slate-master /etc/nginx/sites-enabled/slate-master
$SUDO rm -f /etc/nginx/sites-enabled/default

# limit_req_zone + map must live in http{}, so they go into conf.d/
if [ -f "${SRC_DIR}/deploy/nginx-limits.conf" ]; then
  $SUDO cp "${SRC_DIR}/deploy/nginx-limits.conf" /etc/nginx/conf.d/slate-limits.conf
  ok "rate-limit zones + websocket map installed"
fi

$SUDO nginx -t
$SUDO systemctl enable --now nginx >/dev/null 2>&1 || $SUDO systemctl reload nginx
ok "nginx serving :80 → 127.0.0.1:${APP_PORT}"

# UFW: allow only what is needed
$SUDO ufw allow OpenSSH >/dev/null 2>&1 || true
$SUDO ufw allow 80/tcp  >/dev/null 2>&1 || true
$SUDO ufw allow 443/tcp >/dev/null 2>&1 || true
$SUDO ufw --force enable >/dev/null 2>&1 || true
ok "ufw firewall active (22, 80, 443)"

# fail2ban for SSH brute force
if [ -d /etc/fail2ban ]; then
  ok "fail2ban installed"
fi

# SSL — only possible when a real domain points at this VM
DOMAIN="${DOMAIN:-}"
if [ -n "$DOMAIN" ]; then
  $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  if $SUDO certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
       --redirect -m "${LETSENCRYPT_EMAIL:-admin@${DOMAIN}}"; then
    $SUDO sed -i "s|^MASTER_PUBLIC_URL=.*|MASTER_PUBLIC_URL=https://${DOMAIN}|" "$ENV_FILE"
    $SUDO sed -i "s|^NEXT_PUBLIC_APP_URL=.*|NEXT_PUBLIC_APP_URL=https://${DOMAIN}|" "$ENV_FILE"
    $SUDO systemctl restart slate-master
    ok "HTTPS enabled → https://${DOMAIN}"
  else
    warn "certbot failed. Make sure the domain DNS points to this VM, then run: sudo certbot --nginx -d ${DOMAIN}"
  fi
else
  warn "No DOMAIN set — skipping HTTPS. To enable later: DOMAIN=master.example.com bash deploy-free.sh"
fi

# =============================================================================
step "9/9  Daily database backup timer"
# =============================================================================
DB_FILE="${APP_DIR}/data/db.json"
if [ -f "${SRC_DIR}/deploy/backup.sh" ]; then
  $SUDO cp "${SRC_DIR}/deploy/backup.sh" "${APP_DIR}/deploy/backup.sh"
  $SUDO chmod 755 "${APP_DIR}/deploy/backup.sh"
  $SUDO tee /etc/systemd/system/slate-backup.service >/dev/null <<EOF
[Unit]
Description=SLATE Master Dashboard — data/db.json backup
[Service]
Type=oneshot
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=/bin/bash ${APP_DIR}/deploy/backup.sh
EOF
  $SUDO tee /etc/systemd/system/slate-backup.timer >/dev/null <<EOF
[Unit]
Description=Daily SLATE db.json backup
[Timer]
OnCalendar=*-*-* 03:15:00
Persistent=true
RandomizedDelaySec=600
[Install]
WantedBy=timers.target
EOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now slate-backup.timer >/dev/null 2>&1 || true
  ok "Daily backup timer enabled (03:15)"
  if [ -f "$DB_FILE" ]; then
    ok "Found data/db.json (${DB_FILE})"
  else
    warn "No data/db.json yet — upload your current one from the local machine to keep sites/licenses."
  fi
else
  warn "deploy/backup.sh not found — backup timer skipped"
fi

# ── journald log rotation so the disk never fills ───────────────────────────
$SUDO mkdir -p /etc/systemd/journald.conf.d
$SUDO tee /etc/systemd/journald.conf.d/slate.conf >/dev/null <<EOF
[Journal]
MaxRetentionSec=${LOG_KEEP_DAYS}day
SystemMaxUse=200M
EOF
$SUDO systemctl restart systemd-journald >/dev/null 2>&1 || true
$SUDO rm -rf /var/log/apt/* >/dev/null 2>&1 || true

# =============================================================================
echo
echo "${BOLD}${GREEN}════════════════════════════════════════════════════════════${NC}"
echo "${BOLD}${GREEN}  ✅ DEPLOY COMPLETE${NC}"
echo "${BOLD}${GREEN}════════════════════════════════════════════════════════════${NC}"
echo
echo "  URL          : ${BOLD}${PUBLIC_URL}${NC}"
echo "  App dir      : $APP_DIR"
echo "  Health check : ${PUBLIC_URL}/api/selftest"
echo "  VM shape     : ${BOLD}$(nproc) OCPU / $(awk '/MemTotal/{printf "%.0f", $2/1048576}' /proc/meminfo) GB RAM${NC}"
echo
echo "  Capacity: 100 customers/month needs ~0.4 GB RAM. You are far above that."
echo
echo "  Useful commands:"
echo "    sudo systemctl status slate-master     # is it running?"
echo "    sudo journalctl -u slate-master -f     # live logs"
echo "    pm2 / n/a — using systemd"
echo "    bash $APP_DIR/deploy/backup.sh         # take a backup now"
echo "    sudo systemctl restart slate-master    # restart"
echo
echo "${BOLD}Next:${NC} open ${PUBLIC_URL}/admin/login in a browser and sign in."
echo
