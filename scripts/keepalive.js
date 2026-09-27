/*
 * SLATE DevOps OS — Master Dashboard
 * Keep-alive pinger for the Render FREE web service.
 *
 * WHY THIS EXISTS
 * ---------------
 * Render's free web service spins DOWN after 15 minutes without inbound traffic,
 * and the first request after that waits 30-60 s while the container restarts.
 * A scheduled GET every 10 minutes never reaches the idle threshold, so the
 * dashboard stays warm.
 *
 * This is the same body as deploy/keepalive.sh, written in Node so it runs on
 * Windows, Linux, macOS and inside a GitHub Actions runner without bash.
 *
 * USAGE
 * -----
 *   node scripts/keepalive.js                              # uses MASTER_PUBLIC_URL
 *   node scripts/keepalive.js https://app.onrender.com     # explicit base URL
 *   node scripts/keepalive.js https://app.onrender.com --loop   # self-scheduling
 *
 * In CI the workflow .github/workflows/keepalive.yml calls the first form every
 * 10 minutes, so no machine of yours has to stay switched on.
 *
 * EXIT CODES
 * ----------
 *   0  pinged successfully (self-test green, or a non-JSON but HTTP-2xx body)
 *   1  unreachable, HTTP error, or the self-test reported failed checks
 */
"use strict";

const BASE =
  process.argv.find((a) => a.startsWith("http")) ||
  process.env.MASTER_PUBLIC_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "";
const LOOP = process.argv.includes("--loop");
const INTERVAL_MS = 10 * 60 * 1000; // 10 min — Render idles at 15
const TIMEOUT_MS = 90_000; // a cold container can take ~60s to accept traffic

/** Build the health URL. Mirrors deploy/keepalive.sh: a bare base gets the
 *  documented health path appended; anything already under /api/ is left alone. */
function buildUrl(raw) {
  let url = String(raw || "").trim().replace(/\/+$/, "");
  if (!url) return null;
  if (!/\/api\//.test(url)) url = `${url}/api/selftest`;
  return url;
}

async function ping() {
  const url = buildUrl(BASE);
  if (!url) {
    // Not configured is not an error — a local checkout should stay quiet.
    console.log("keepalive: MASTER_PUBLIC_URL not set, nothing to ping.");
    return true;
  }

  const started = Date.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "slate-keepalive/1.0" },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = await res.text();
    const ms = Date.now() - started;
    let ok = true;
    try {
      const data = JSON.parse(body);
      ok = !data.failed;
      console.log(`keepalive: OK ${url} (${ms} ms) — ${data.summary ?? "no summary"}`);
      if (data.failed) {
        for (const c of (data.checks || []).filter((c) => !c.ok)) {
          console.log(`  FAIL ${c.name}: ${c.detail || ""}`);
        }
      }
    } catch {
      // Non-JSON is fine: the request itself succeeded, which is all we need.
      console.log(`keepalive: OK ${url} (${ms} ms)`);
    }
    return ok;
  } catch (err) {
    console.error(`keepalive: FAIL ${url} — ${err.message}`);
    // No retry: the next scheduled run is 10 minutes away, and hammering a
    // cold container only delays its wake-up.
    return false;
  }
}

(async () => {
  if (!LOOP) {
    process.exit((await ping()) ? 0 : 1);
  }
  // --loop keeps the process resident (e.g. a container with a sidecar timer).
  let failStreak = 0;
  for (;;) {
    const ok = await ping();
    failStreak = ok ? 0 : failStreak + 1;
    if (failStreak >= 6) {
      console.error("keepalive: 6 consecutive failures, exiting.");
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
})();
