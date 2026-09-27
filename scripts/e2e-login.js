/*
 * End-to-end check of the admin login → protected page flow.
 *
 * This is the HTTP equivalent of what the browser does, and it asserts on the
 * OUTCOME rather than on intermediate states:
 *
 *   1. POST the credentials to /api/admin/login
 *   2. keep the Set-Cookie exactly as a browser would (attributes respected)
 *   3. request /licenses WITH that cookie and require 200, not a redirect
 *   4. confirm the response is the dashboard, not the login page again
 *   5. confirm a forged cookie is still refused (the guard did not just get
 *      loosened into "allow everything")
 *
 * Step 5 matters as much as step 3 — an "always accept" regression would pass a
 * naive test of this bug while re-opening the dashboard to anyone.
 *
 * Run: node scripts/e2e-login.js
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BASE = process.env.E2E_BASE_URL || "http://localhost:3000";

function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}
const env = readEnv(path.join(__dirname, "..", ".env.local"));

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

(async () => {
  console.log(`\nEnd-to-end login flow against ${BASE}\n`);

  const user = env.ADMIN_USERNAME || "masterops";
  const pass = env.ADMIN_PASSWORD || "";
  if (!pass) {
    console.log("ADMIN_PASSWORD missing from .env.local — cannot run.");
    process.exit(1);
  }

  // ── 1. log in ────────────────────────────────────────────────────────────
  const login = await fetch(`${BASE}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: user, password: pass }),
  });
  const loginBody = await login.json().catch(() => ({}));
  check("POST /api/admin/login returns 200", login.status === 200, `got ${login.status}`);
  check("login reports success", loginBody.success === true, JSON.stringify(loginBody));

  // ── 2. take the cookie as a browser would ────────────────────────────────
  //
  // A browser obeys the attributes: it discards a `Secure` cookie that arrived
  // over plain HTTP, and keeps everything else. We model that here so a
  // regression in createSessionCookie() cannot slip past.
  const setCookie = login.headers.get("set-cookie") || "";
  const cookiePair = setCookie.split(";")[0];
  const isSecure = /;\s*Secure/i.test(setCookie);
  const overHttp = BASE.startsWith("http://");
  const browserWouldStore = !(isSecure && overHttp);

  check("a session cookie was issued", cookiePair.startsWith("slate_session="), cookiePair.slice(0, 24) + "…");
  check(
    "browser would keep this cookie",
    browserWouldStore,
    isSecure && overHttp ? "Secure over HTTP — browsers DISCARD this" : ""
  );

  if (!browserWouldStore) {
    console.log("\nStopping: the browser would never send this cookie to /licenses.\n");
    process.exit(1);
  }

  // ── 3. protected page WITH the cookie ────────────────────────────────────
  const page = await fetch(`${BASE}/licenses`, {
    headers: { Cookie: cookiePair },
    redirect: "manual",
  });
  const location = page.headers.get("location") || "";
  check(
    "GET /licenses with the session cookie returns 200",
    page.status === 200,
    `got ${page.status}${location ? " -> " + location : ""}`
  );

  // ── 4. it is the dashboard, not the login page ───────────────────────────
  if (page.status === 200) {
    const html = await page.text();
    const looksLikeLogin = /SIGN IN TO MASTER|Master Operator Console/i.test(html);
    const looksLikeDashboard = /licen[cs]e/i.test(html);
    check("response is the dashboard, not the login page", !looksLikeLogin);
    check("dashboard content present", looksLikeDashboard);
  }

  // ── 5. the guard still refuses forgeries ─────────────────────────────────
  const forged = ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", Buffer.from(
    JSON.stringify({ role: "admin", username: "masterops", exp: Math.floor(Date.now() / 1000) + 3600 })
  ).toString("base64url"), "Zm9yZ2VkLXNpZ25hdHVyZS1ub3QtdmFsaWQ"].join(".");

  const forgedRes = await fetch(`${BASE}/licenses`, {
    headers: { Cookie: `slate_session=${forged}` },
    redirect: "manual",
  });
  check(
    "a FORGED admin token is still refused",
    forgedRes.status !== 200,
    `got ${forgedRes.status}`
  );

  const anonRes = await fetch(`${BASE}/licenses`, { redirect: "manual" });
  check("anonymous is still refused", anonRes.status !== 200, `got ${anonRes.status}`);

  // ── 6. the API and the middleware now agree ──────────────────────────────
  const verify = await fetch(`${BASE}/api/auth/verify`, { headers: { Cookie: cookiePair } });
  const verifyBody = await verify.json().catch(() => ({}));
  check(
    "/api/auth/verify agrees with the middleware",
    verify.status === 200 && verifyBody.authenticated === true && page.status === 200,
    `verify=${verify.status} middleware=${page.status}`
  );

  console.log(
    failures === 0
      ? "\nAll checks passed — login reaches the dashboard.\n"
      : `\n${failures} CHECK(S) FAILED\n`
  );
  process.exitCode = failures === 0 ? 0 : 1;
})();