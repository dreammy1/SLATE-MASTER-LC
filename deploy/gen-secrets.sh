#!/usr/bin/env bash
# =============================================================================
#  SLATE DevOps OS — secret generator
#  Run on Windows PowerShell OR Linux/macOS bash.
# =============================================================================
#  Produces strong random values for ENCRYPTION_SECRET, JWT_SECRET and an
#  admin password. No secrets ever get typed by hand again.
# =============================================================================
set -Eeuo pipefail

if command -v openssl >/dev/null 2>&1; then
  secret() { openssl rand -hex 48; }
  password() { openssl rand -base64 18 | tr -d '/+=' | cut -c1-20; }
elif command -v node >/dev/null 2>&1; then
  secret()   { node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"; }
  password() { node -e "console.log(require('crypto').randomBytes(15).toString('base64url').slice(0,20))"; }
else
  echo "Need either openssl or node to generate secure random values." >&2
  exit 1
fi

ENC="$(secret)"
JWT="$(secret)"
PW="$(password)"

cat <<EOF
# ─────────────────────────────────────────────────────────────
#  SLATE DevOps OS — your new secrets
#  Generated $(date -u '+%Y-%m-%d %H:%M UTC')
# ─────────────────────────────────────────────────────────────

ENCRYPTION_SECRET=$ENC
JWT_SECRET=$JWT
ADMIN_USERNAME=masterops
ADMIN_PASSWORD=$PW

# ⚠️  ENCRYPTION_SECRET ইতিমধ্যে ডিপ্লয় করা সাইটগুলোর
#     ডাটা ডিক্রিপ্ট করতে ব্যবহৃত হয়। সেই সাইট চালু থাকলে
#     এটি আর কখনো বদলাবেন না — নইলে পুরনো ডেটা পড়া যাবে না।
#
# ⚠️  ADMIN_PASSWORD এখনই নোট করে রাখুন, তারপর
#     .env.local ফাইলে বসিয়ে দিন।
EOF
