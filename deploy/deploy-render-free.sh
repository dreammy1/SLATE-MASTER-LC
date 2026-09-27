#!/usr/bin/env bash
# =============================================================================
#  SLATE DevOps OS — Master Dashboard
#  Render + Upstash free-tier deployment helper
# =============================================================================
#  WHAT THIS DOES
#  --------------
#  Walks you through the free hosting path end to end and generates the exact
#  values Render asks for, so you do not have to hand-craft secrets:
#
#    1. Prints the two secrets to paste into Render (ENCRYPTION_SECRET, JWT_SECRET)
#    2. Verifies the deployed app is actually reachable and authenticated-safe
#    3. Reports the correct MASTER_PUBLIC_URL to set
#    4. Optionally migrates your existing data/db.json into Upstash
#
#  It does NOT create accounts or touch your cloud console — those need a human
#  in a browser. Everything else is automated.
#
#  USAGE
#  -----
#      bash deploy/deploy-render-free.sh gen-secrets
#      bash deploy/deploy-render-free.sh verify https://slate-master.onrender.com
#      bash deploy/deploy-render-free.sh migrate  https://slate-master.onrender.com
#
#  Requires: node (for JSON checks and secret generation)
# =============================================================================
set -Eeuo pipefail

BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; CYAN=$'\033[36m'; NC=$'\033[0m'
step() { echo; echo "${BOLD}${CYAN}==> $*${NC}"; }
ok()   { echo "  ${GREEN}✓${NC} $*"; }
warn() { echo "  ${YELLOW}!${NC} $*"; }
fail() { echo "  ${RED}✗${NC} $*" >&2; }
die()  { fail "$*"; exit 1; }

need_node() {
  command -v node >/dev/null 2>&1 || die "node is required but was not found in PATH."
}
gen_secret() { node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"; }

CMD="${1:-help}"

# =============================================================================
case "$CMD" in
# =============================================================================
gen-secrets)
  need_node

  # ⚠️ If you are MIGRATING an existing install, do NOT generate a new
  #    ENCRYPTION_SECRET — reuse the one in your current .env.local, or every
  #    stored database password and handshake token becomes unreadable.
  EXISTING=""
  for f in .env.local .env .env.production deploy/.env.production; do
    if [ -f "$f" ]; then
      v="$(grep -E '^ENCRYPTION_SECRET=' "$f" 2>/dev/null | head -n1 | cut -d= -f2- || true)"
      if [ -n "$v" ]; then EXISTING="$v"; FOUND_IN="$f"; break; fi
    fi
  done

  step "Secrets for Render → Environment"
  if [ -n "$EXISTING" ]; then
    echo "  ${BOLD}ENCRYPTION_SECRET${NC}  (reused from ${FOUND_IN} — keeps existing sites readable)"
    echo "  ${BOLD}${EXISTING}${NC}"
  else
    echo "  ${BOLD}ENCRYPTION_SECRET${NC}  (fresh install)"
    echo "  ${BOLD}$(gen_secret)${NC}"
    warn "Save this somewhere safe. Never change it after your first customer."
  fi
  echo
  echo "  ${BOLD}JWT_SECRET${NC}   (session signing — safe to regenerate any time)"
  echo "  ${BOLD}$(gen_secret)${NC}"
  echo
  echo "  ${BOLD}ADMIN_PASSWORD${NC}   (pick your own strong value, or use)"
  echo "  ${BOLD}$(gen_secret | cut -c1-24)${NC}"
  echo
  echo "  Paste each into Render → your service → Environment → Add Environment Variable."
  echo "  Leave ${BOLD}sync: false${NC} variables blank in render.yaml; Render prompts you."
  ;;

# =============================================================================
verify)
  need_node
  URL="${2:-}"
  [ -n "$URL" ] || die "Usage: bash deploy/deploy-render-free.sh verify https://your-app.onrender.com"
  URL="${URL%/}"

  step "1/4  Reaching ${URL}"
  # A cold Render free service takes ~1 minute to wake, so allow for it and say
  # so, rather than reporting a false failure.
  if curl -fsS --max-time 90 "${URL}/api/selftest" -o /tmp/slate-selftest.json; then
    ok "App responded"
  else
    warn "No response. If this is a fresh deploy, wait 60s — Render free services"
    warn "sleep after 15 minutes idle and take about a minute to spin back up."
    die "Could not reach ${URL}/api/selftest"
  fi

  step "2/4  Self-test"
  node -e "
    const d=require('/tmp/slate-selftest.json');
    console.log('  summary:', JSON.stringify(d.summary));
    (d.checks||[]).filter(c=>!c.ok).forEach(c=>console.log('  FAIL', c.name, c.detail||''));
    process.exit(d.failed?1:0);
  " && ok "All self-tests passed" || warn "Some self-tests failed — see above"

  step "3/4  Master public URL"
  # If this reports loopback, clients will get "Failed to fetch" — the single
  # most common deployment mistake.
  if curl -fsS --max-time 30 "${URL}/api/master/url" -o /tmp/slate-origin.json 2>/dev/null; then
    node -e "
      const d=require('/tmp/slate-origin.json');
      const o=d.origin||d.masterPublicUrl||'';
      if(!o){ console.log('  ${RED}No public URL configured.${NC} Set MASTER_PUBLIC_URL in Render.'); process.exit(2); }
      if(/localhost|127\.0\.0\.1/.test(o)){ console.log('  ${RED}'+o+' is loopback — clients cannot reach it.${NC}'); process.exit(3); }
      console.log('  Master URL: ${GREEN}'+o+'${NC}');
    " && ok "Public URL looks correct" || warn "Fix MASTER_PUBLIC_URL before handing this to a customer"
  else
    warn "Could not read /api/master/url (endpoint may need auth) — check MASTER_PUBLIC_URL manually."
  fi

  step "4/4  Storage driver"
  echo "  Confirm the app is on Upstash, not an ephemeral disk."
  echo "  In Render → your service → Logs, the first request should not warn about"
  echo "  SLATE_READONLY. If it does, STORAGE_DRIVER / KV_REST_API_* are missing."
  echo
  echo "  ${BOLD}Next:${NC} set up the keep-alive so the service does not sleep."
  echo "    https://console.cron-job.org → New cronjob"
  echo "      URL      : ${URL}/api/selftest"
  echo "      Schedule : every 10 minutes"
  echo "      Method   : GET"
  echo
  ok "Verification finished"
  ;;

# =============================================================================
migrate)
  need_node
  URL="${2:-}"
  [ -n "$URL" ] || die "Usage: bash deploy/deploy-render-free.sh migrate https://your-app.onrender.com"
  URL="${URL%/}"

  DB_FILE="data/db.json"
  [ -f "$DB_FILE" ] || die "$DB_FILE not found. Run this from the project root."
  node -e "JSON.parse(require('fs').readFileSync('$DB_FILE','utf8'))" \
    || die "$DB_FILE is not valid JSON — fix it before migrating."

  step "Migrating $DB_FILE → ${URL}"
  warn "This uploads your live sites, licences, orders and ENCRYPTED secrets."
  warn "The target must use the SAME ENCRYPTION_SECRET, or the secrets stay unreadable."
  echo
  echo "  Two supported ways to move the data:"
  echo
  echo "  ${BOLD}A) Upstash console (simplest, no export endpoint needed)${NC}"
  echo "     1. Open your Upstash database → Data Browser → CLI / REST"
  echo "     2. Run:  SET slate:db \"\$(cat $DB_FILE | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>process.stdout.write(JSON.stringify(s)))')\""
  echo "        (the value must be the file contents JSON-encoded as one string)"
  echo
  echo "  ${BOLD}B) Temporary admin endpoint${NC}"
  echo "     If you prefer an upload endpoint, add one that requires an admin session"
  echo "     and writes through saveDb(); do not expose an unauthenticated import."
  echo
  echo "  After importing, reload the dashboard and confirm the site/licence counts"
  echo "  match this file:"
  node -e "
    const d=require('./$DB_FILE');
    console.log('    sites:', (d.sites||[]).length,
                '| databases:', (d.databases||[]).length,
                '| licences:', (d.licenses||[]).length,
                '| orders:', (d.orders||[]).length);
  "
  echo
  ok "Instructions printed"
  ;;

# =============================================================================
*)
  echo
  echo "${BOLD}SLATE DevOps OS — free hosting helper${NC}"
  echo
  echo "  Deploying to Render + Upstash (no Oracle, no VPS, no credit card):"
  echo "    1. Push this repo to GitHub"
  echo "    2. Create a free Upstash Redis DB → copy REST URL + TOKEN"
  echo "    3. Render → New + → Blueprint → select the repo (uses render.yaml)"
  echo "    4. Run:  bash deploy/deploy-render-free.sh gen-secrets"
  echo "    5. Paste the printed secrets when Render prompts"
  echo "    6. Run:  bash deploy/deploy-render-free.sh verify https://your-app.onrender.com"
  echo "    7. Run:  bash deploy/deploy-render-free.sh migrate https://your-app.onrender.com"
  echo
  echo "  Full walkthrough: deploy/FREE-HOSTING-GUIDE.md"
  echo
  ;;
esac