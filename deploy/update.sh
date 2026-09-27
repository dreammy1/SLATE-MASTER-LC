#!/usr/bin/env bash
# =============================================================================
#  SLATE DevOps OS — Master Dashboard
#  Safe code update: pull → install → build → restart, with a rollback.
# =============================================================================
#  Run on the VM from inside the project directory:
#      cd /opt/slate-master-dashboard && bash deploy/update.sh
#
#  Env flags:
#      SKIP_PULL=1        don't run `git pull` (you already uploaded files)
#      SKIP_INSTALL=1     don't run `npm install`
#      FORCE_BUILD=1      always rebuild even if .next exists
#      NO_RESTART=1       build only, do not restart the service
# =============================================================================
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/slate-master-dashboard}"
SERVICE="${SERVICE:-slate-master}"
BACKUP_DIR="${APP_DIR}/backups"

BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; CYAN=$'\033[36m'; NC=$'\033[0m'
step() { echo; echo "${BOLD}${CYAN}==> $*${NC}"; }
ok()   { echo "  ${GREEN}✓${NC} $*"; }
warn() { echo "  ${YELLOW}!${NC} $*"; }
fail() { echo "  ${RED}✗${NC} $*" >&2; exit 1; }
trap 'fail "Update failed at line $LINENO — the old build is still running."' ERR

cd "$APP_DIR"
[ -f package.json ] || fail "package.json not found in $APP_DIR"

# ── 0. Pre-flight: is the service healthy right now? ────────────────────────
step "0/6  Pre-flight health check"
PREV_BUILD_ID=""
if [ -f .next/BUILD_ID ]; then
  PREV_BUILD_ID="$(cat .next/BUILD_ID)"
  cp -a .next "${BACKUP_DIR}/.next.rollback" 2>/dev/null || true
  ok "Previous build saved for rollback (BUILD_ID=$PREV_BUILD_ID)"
fi
if [ -f data/db.json ]; then
  mkdir -p "$BACKUP_DIR"
  cp -a data/db.json "${BACKUP_DIR}/db.json.$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
  ok "data/db.json backed up"
fi

# ── 1. Pull latest code ─────────────────────────────────────────────────────
step "1/6  Fetching latest code"
if [ "${SKIP_PULL:-0}" = "1" ]; then
  warn "SKIP_PULL=1 — using the files already on disk"
elif [ -d .git ] && command -v git >/dev/null 2>&1; then
  git fetch --all
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  git pull --ff-only origin "$BRANCH"
  ok "Pulled $BRANCH"
else
  warn "No .git directory — assuming files were uploaded via scp/rsync"
fi

# ── 2. Never let a code update clobber the live database ───────────────────
step "2/6  Protecting data/ and .env.local"
mkdir -p data
if [ -f .env.local ]; then
  ok ".env.local present (left untouched)"
else
  fail ".env.local is missing! Restore it from backups before updating — without it, encrypted site data cannot be read."
fi
# Show a live sanity check that db.json is valid JSON before we touch anything.
if [ -f data/db.json ]; then
  node -e "JSON.parse(require('fs').readFileSync('data/db.json','utf8')); console.log('  db.json is valid JSON')" \
    || fail "data/db.json is corrupt — do not continue. Restore from backups/."
fi

# ── 3. Dependencies ─────────────────────────────────────────────────────────
step "3/6  Installing dependencies"
if [ "${SKIP_INSTALL:-0}" = "1" ]; then
  warn "SKIP_INSTALL=1"
elif [ -f package-lock.json ]; then
  npm ci --include=dev || npm install --include=dev
else
  npm install
fi
ok "Dependencies ready"

# ── 4. Build (the risky part — old build stays live until it succeeds) ──────
step "4/6  Building"
export NODE_OPTIONS="--max-old-space-size=3072"
if [ -f .next/BUILD_ID ] && [ "${FORCE_BUILD:-0}" != "1" ]; then
  warn "Build already exists — set FORCE_BUILD=1 to force a rebuild"
else
  npm run build
  ok "Build succeeded"
fi

# ── 5. Restart ──────────────────────────────────────────────────────────────
step "5/6  Restarting ${SERVICE}"
if [ "${NO_RESTART:-0}" = "1" ]; then
  warn "NO_RESTART=1 — service not restarted"
else
  sudo systemctl restart "$SERVICE"
  sleep 5
  if sudo systemctl is-active --quiet "$SERVICE"; then
    ok "$SERVICE is running"
  else
    warn "Service failed. Rolling back to the previous build..."
    if [ -d "${BACKUP_DIR}/.next.rollback" ]; then
      rm -rf .next && mv "${BACKUP_DIR}/.next.rollback" .next
      sudo systemctl restart "$SERVICE" || true
      ok "Rolled back"
    fi
    sudo journalctl -u "$SERVICE" -n 40 --no-pager || true
    fail "Could not start the new build. See logs above (old version restored)."
  fi
fi

# ── 6. Health check ─────────────────────────────────────────────────────────
step "6/6  Health check"
BASE_URL="$(grep -E '^NEXT_PUBLIC_APP_URL=' .env.local 2>/dev/null | cut -d= -f2- || true)"
[ -z "$BASE_URL" ] && BASE_URL="http://127.0.0.1:3000"
if curl -fsS --max-time 15 "${BASE_URL}/api/selftest" -o /tmp/slate-selftest.json; then
  ok "selftest responded"
  node -e "
    const d=require('/tmp/slate-selftest.json');
    console.log('  summary:', JSON.stringify(d.summary));
    (d.checks||[]).filter(c=>!c.ok).forEach(c=>console.log('  FAIL', c.name, c.detail||''));
  " 2>/dev/null || cat /tmp/slate-selftest.json
  if node -e "const d=require('/tmp/slate-selftest.json'); process.exit(d.failed?1:0)" 2>/dev/null; then
    ok "All self-tests passed"
  else
    warn "Some self-tests reported failures — scroll up for details."
  fi
else
  warn "Could not reach ${BASE_URL}/api/selftest over the public URL."
  warn "Local check: curl -s http://127.0.0.1:3000/api/selftest"
fi

# ── Cleanup old rollback copies ─────────────────────────────────────────────
find "$BACKUP_DIR" -maxdepth 1 -name '.next.rollback' -type d -mtime +1 -exec rm -rf {} + 2>/dev/null || true

echo
echo "${BOLD}${GREEN}✅ Update complete.${NC} Site: ${BASE_URL}"
