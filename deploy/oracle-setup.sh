#!/bin/bash
###############################################################################
# SLATE DevOps OS — Master Dashboard
# Oracle Cloud Free VPS (Ubuntu 22.04/24.04) Auto-Setup Script
#
# PREREQUISITES (do these MANUALLY first in Oracle Cloud Console):
#   1. Create an Always Free VM.Standard.A1.Flex instance (Ubuntu 24.04)
#   2. Add your SSH public key
#   3. Open port 3000 (and/or 80/443) in the Security List / Network Firewall
#
# USAGE (on your local machine, after cloning this repo to the VPS):
#   ssh -i YOUR_KEY.pem ubuntu@YOUR_PUBLIC_IP
#   cd /opt/slate-master-dashboard
#   sudo bash deploy/oracle-setup.sh
###############################################################################
set -euo pipefail

echo "=========================================="
echo "  SLATE DevOps OS — VPS Setup Starting"
echo "=========================================="

# ── 0. Ensure root ─────────────────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
  echo "[ERROR] Please run with: sudo bash deploy/oracle-setup.sh"
  exit 1
fi

# ── 1. Update system ───────────────────────────────────────────────────────
echo "[1/8] Updating apt packages..."
apt-get update -y
apt-get upgrade -y

# ── 2. Install Node.js 20 (LTS) ────────────────────────────────────────────
echo "[2/8] Installing Node.js 20 LTS..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# ── 3. Install PM2 (process manager) ───────────────────────────────────────
echo "[3/8] Installing PM2..."
npm install -g pm2
pm2 startup systemd -u ubuntu --hp /home/ubuntu
echo "[INFO] PM2 startup command configured."

# ── 4. Install Nginx ──────────────────────────────────────────────────────
echo "[4/8] Installing Nginx..."
apt-get install -y nginx

# ── 5. Ensure app directory exists ────────────────────────────────────────
APP_DIR="/opt/slate-master-dashboard"
echo "[5/8] Ensuring app directory: ${APP_DIR}"
mkdir -p "${APP_DIR}"
mkdir -p "${APP_DIR}/logs"
mkdir -p "${APP_DIR}/data"

# ── 6. Install app dependencies (if package.json exists) ───────────────────
if [ -f "${APP_DIR}/package.json" ]; then
  echo "[6/8] Installing npm dependencies..."
  cd "${APP_DIR}"
  npm ci --only=production
  npm run build
else
  echo "[6/8] SKIP: package.json not found in ${APP_DIR}"
  echo "         Clone your repo here first: git clone <repo> ${APP_DIR}"
fi

# ── 7. Configure Nginx reverse proxy ───────────────────────────────────────
echo "[7/8] Configuring Nginx..."
cat > /etc/nginx/sites-available/slate-master << 'NGINX'
server {
    listen 80;
    server_name _;

    # Security headers
    add_header X-Content-Type-Options nosniff;
    add_header X-Frame-Options SAMEORIGIN;
    add_header X-XSS-Protection "1; mode=block";

    # Proxy to Next.js (PM2-managed on port 3000)
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    # Static file caching (Next.js _next)
    location /_next/static/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_cache_valid 200 1y;
        add_header Cache-Control "public, immutable";
    }
}
NGINX

ln -sf /etc/nginx/sites-available/slate-master /etc/nginx/sites-enabled/slate-master
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
echo "[INFO] Nginx configured and reloaded."

# ── 8. Start PM2 (if ecosystem.config.js exists) ───────────────────────────
echo "[8/8] Starting PM2 (if ecosystem.config.js exists)..."
if [ -f "${APP_DIR}/ecosystem.config.js" ]; then
  cd "${APP_DIR}"
  pm2 start ecosystem.config.js --env production
  pm2 save
  echo "[INFO] PM2 started and saved."
else
  echo "[8/8] SKIP: ecosystem.config.js not found. Start manually with:"
  echo "        pm2 start server.js --name slate-master-dashboard"
fi

# ── Done ───────────────────────────────────────────────────────────────────
echo "=========================================="
echo "  Setup Complete!"
echo "=========================================="
echo "Your dashboard should be live at: http://YOUR_PUBLIC_IP"
echo "Set MASTER_PUBLIC_URL in .env.local to: http://YOUR_PUBLIC_IP"
echo "Then restart: pm2 restart slate-master-dashboard"
echo "Check logs:  pm2 logs slate-master-dashboard"
echo "=========================================="
