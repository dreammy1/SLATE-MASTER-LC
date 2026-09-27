#!/usr/bin/env bash
# =============================================================================
#  SLATE DevOps OS — Master Dashboard
#  Keep-alive pinger for a Render FREE web service.
# =============================================================================
#  WHY
#  ---
#  Render's free web service spins DOWN after 15 minutes without inbound
#  traffic, and the first request after that waits roughly 30-60 seconds while
#  the container restarts. For a dashboard whose customers hit it from a
#  bookmarked order-status page, that delay is very visible.
#
#  A scheduled GET every 10 minutes is enough to hold it awake: 15 minutes of
#  idle is never reached. This script is the body of a cron-job.org job:
#
#     URL      : https://your-app.onrender.com/api/selftest
#     Schedule : every 10 minutes
#     Method   : GET
#
#  ── Running it yourself (cron-job.org, UptimeRobot, or local cron) ──────────
#
#  With no arguments it pings $MASTER_PUBLIC_URL. Pass a URL to override:
#
#      bash deploy/keepalive.sh
#      bash deploy/keepalive.sh https://my-app.onrender.com
#
#  ── Why /api/selftest and not / ────────────────────────────────────────────
#
#  The pinger must exercise the same path a real visitor takes, so that a
#  sleeping container proves it can also serve the dashboard. /api/selftest
#  touches the storage adapter and the crypto layer, so a wake-up that fails to
#  load configuration is detected here rather than during a customer's call.
#  It is unauthenticated but returns only a pass/fail summary — no secrets.
#
#  ── Cost ────────────────────────────────────────────────────────────────────
#
#  6 requests/hour * 24 * 30 = 4,320 requests/month. The Upstash free tier
#  allows 500,000 commands/month, and each of these is a single GET, so the
#  pinger costs well under 1% of the budget (see scripts/capacity-model.js).
# =============================================================================
set -uo pipefail

URL="${1:-${MASTER_PUBLIC_URL:-}}"

if [ -z "$URL" ]; then exit 0; fi   # not configured — stay quiet, not an error
URL="${URL%/}"

# /api/selftest is the documented health contract; append it if a bare URL was given.
case "$URL" in
  *"/api/"*) : ;;
  *) URL="${URL}/api/selftest" ;;
esac

# 90s: a cold free-tier container can legitimately take ~60s to accept traffic,
# so a shorter timeout would produce false alarms and pointless retries.
BODY="$(curl -fsS --max-time 90 "$URL" 2>/dev/null)" || {
  # A failed ping is not worth retrying here — the next scheduled run is 10
  # minutes away, and hammering a cold container only delays its wake-up.
  exit 1
}

# Surface a failing summary to the cron provider's log so problems are visible.
if command -v node >/dev/null 2>&1; then
  echo "$BODY" | node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c)).on("end", () => {
      try {
        const d = JSON.parse(raw);
        if (d.failed) {
          console.log("slate keepalive: WARN " + (d.summary || "self-test reported failures"));
          (d.checks || []).filter((c) => !c.ok)
            .forEach((c) => console.log("  FAIL " + c.name + ": " + (c.detail || "")));
        }
      } catch {
        /* Non-JSON body is fine; the request itself succeeded. */
      }
    });
  '
fi

exit 0