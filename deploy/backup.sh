#!/usr/bin/env bash
# =============================================================================
#  SLATE DevOps OS — Master Dashboard
#  data/db.json backup + rotation
#
#  This file is the ONLY copy of your sites, licenses, orders, databases and
#  handshake tokens. Losing it means losing the panel. Hence this script plus
#  the systemd timer installed by deploy/deploy-free.sh (daily at 03:15).
# =============================================================================
#  Manual run:   bash /opt/slate-master-dashboard/deploy/backup.sh
# =============================================================================
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/slate-master-dashboard}"
DB_FILE="${APP_DIR}/data/db.json"
BACKUP_DIR="${APP_DIR}/backups"
KEEP="${BACKUP_KEEP_COUNT:-14}"          # keep 14 daily copies
STAMP="$(date -u '+%Y%m%d-%H%M%S')"
BACKUP_FILE="${BACKUP_DIR}/db-${STAMP}.json"

BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; NC=$'\033[0m'

[ -f "$DB_FILE" ] || { echo "${RED}No database at $DB_FILE — nothing to back up.${NC}"; exit 0; }

mkdir -p "$BACKUP_DIR"

# 1. Never back up a half-written file: copy to a temp name, verify, then rename.
TMP="${BACKUP_FILE}.tmp"
cp "$DB_FILE" "$TMP"

# 2. Validate the copy is real JSON before we call it a backup.
if command -v node >/dev/null 2>&1; then
  node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$TMP" \
    || { rm -f "$TMP"; echo "${RED}✗ Backup copy is not valid JSON — aborted, original untouched.${NC}"; exit 1; }
fi
mv "$TMP" "$BACKUP_FILE"
chmod 600 "$BACKUP_FILE"

SIZE="$(du -h "$BACKUP_FILE" | cut -f1)"
echo "${GREEN}✓${NC} Backed up → ${BACKUP_FILE} (${SIZE})"

# 3. Rotate: delete the oldest beyond $KEEP
COUNT="$(find "$BACKUP_DIR" -maxdepth 1 -name 'db-*.json' | wc -l)"
if [ "$COUNT" -gt "$KEEP" ]; then
  find "$BACKUP_DIR" -maxdepth 1 -name 'db-*.json' -type f | sort | head -n $(( COUNT - KEEP )) | xargs -r rm -f
  echo "${YELLOW}↻${NC} Rotated — keeping the newest ${KEEP} backups"
fi

# 4. Drop any leftover .tmp files from an interrupted run
find "$BACKUP_DIR" -maxdepth 1 -name '*.tmp' -mmin +60 -delete 2>/dev/null || true

# 5. Push a copy off-box only if the admin configured an rsync target
#    (e.g. REMOTE=ubuntu@backup-host:/var/backups/slate in the systemd unit)
if [ -n "${REMOTE:-}" ] && command -v rsync >/dev/null 2>&1; then
  if rsync -az --timeout=30 "$BACKUP_FILE" "$REMOTE" 2>/dev/null; then
    echo "${GREEN}✓${NC} Off-site copy sent → ${REMOTE}"
  else
    echo "${YELLOW}!${NC} Off-site rsync failed (local backup is still fine)"
  fi
fi

echo "${BOLD}Total backups kept: $(find "$BACKUP_DIR" -maxdepth 1 -name 'db-*.json' | wc -l) in ${BACKUP_DIR}${NC}"
