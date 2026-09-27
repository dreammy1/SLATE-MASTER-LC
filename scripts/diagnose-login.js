/*
 * Diagnose the admin login loop.
 *
 * Reproduces exactly what the browser does:
 *   1. POST /api/admin/login and capture the raw Set-Cookie
 *   2. GET a protected page WITH that cookie and report the status
 *   3. Decode the JWT payload and verify the HMAC the server would check
 *
 * This distinguishes the two possible causes of a login loop:
 *   (a) the cookie is not stored/accepted  -> Set-Cookie attributes wrong
 *   (b) the cookie is stored but rejected  -> signature/secret mismatch
 *
 * Run: node scripts/diagnose-login.js
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BASE = process.env.E2E_BASE_URL || "http://localhost:3000";

// ── read credentials from .env.local ────────────────────────────────────────
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
const USER = env.ADMIN_USERNAME || "masterops";
const PASS = env.ADMIN_PASSWORD || "";

(async () => {
  console.log(`\nBASE=${BASE}  user=${USER}  password=${PASS ? "set" : "MISSING"}\n`);
  if (!PASS) {
    console.log("ADMIN_PASSWORD not found in .env.local — cannot test login.");
    process.exit(1);
  }

  // ── 1. log in ─────────────────────────────────────────────────────────────
  const res = await fetch(`${BASE}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const setCookie = res.headers.get("set-cookie");
  console.log(`1) POST /api/admin/login -> ${res.status}`);
  console.log(`   body       : ${JSON.stringify(await res.text()).slice(0, 120)}`);
  console.log(`   Set-Cookie : ${setCookie}`);

  if (!setCookie) {
    console.log("\n   ❌ No cookie was set — the credentials were rejected.");
    process.exit(1);
  }

  const secureOverHttp = /;\s*Secure/i.test(setCookie) && BASE.startsWith("http://");
  console.log(
    `\n   ${secureOverHttp
      ? "❌ BUG: 'Secure' sent over plain HTTP — a browser DISCARDS this cookie."
      : "✅ No Secure-over-HTTP problem."}`
  );

  const cookiePair = setCookie.split(";")[0];
  const token = cookiePair.split("=").slice(1).join("=");

  // ── 2. does the token verify with the server's secret? ────────────────────
  const secretSource = env.JWT_SECRET || env.ENCRYPTION_SECRET || "slate-devops-auth-fallback-2026";
  const key = Buffer.from(secretSource, "hex").length >= 32
    ? Buffer.from(secretSource, "hex")
    : Buffer.from(secretSource.slice(0, 32).padEnd(32, "0"), "utf8");

  const [h, b, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", key).update(`${h}.${b}`).digest("base64url");
  const sigOk = expected === sig;
  let payload = {};
  try { payload = JSON.parse(Buffer.from(b, "base64url").toString()); } catch {}

  console.log(`\n2) JWT verification with JWT_SECRET/ENCRYPTION_SECRET from .env.local`);
  console.log(`   payload    : ${JSON.stringify(payload)}`);
  console.log(`   signature  : ${sigOk ? "✅ valid" : "❌ INVALID (secret mismatch or tampering)"}`);
  if (payload.exp) {
    const left = payload.exp * 1000 - Date.now();
    console.log(`   expires in : ${(left / 3600000).toFixed(2)} hours`);
  }

  // ── 3. use the cookie on a protected page ─────────────────────────────────
  const page = await fetch(`${BASE}/licenses`, {
    headers: { Cookie: cookiePair },
    redirect: "manual",
  });
  console.log(`\n3) GET /licenses with the session cookie -> ${page.status}`);
  const loc = page.headers.get("location");
  if (page.status === 200) {
    console.log("   ✅ Dashboard reached — login works.");
  } else {
    console.log(`   ❌ Redirected to ${loc} — the guard rejected the session.`);
    const verify = await fetch(`${BASE}/api/auth/verify`, { headers: { Cookie: cookiePair } });
    console.log(`   /api/auth/verify -> ${verify.status} ${(await verify.text()).slice(0, 120)}`);
    console.log(
      "\n   If verify says authenticated:true but the page still redirects, the"
    );
    console.log("   middleware is not reading the cookie. Check the matcher in middleware.ts");
    console.log("   and that no second middleware.ts exists inside app/.");
  }
  console.log("");
  process.exit(page.status === 200 ? 0 : 1);
})();