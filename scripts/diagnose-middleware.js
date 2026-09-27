/*
 * Determines WHY the middleware rejects a valid session.
 *
 * /api/auth/verify accepts the same cookie that the middleware rejects, so the
 * cookie, the signature and the secret are all fine. That leaves exactly two
 * candidates, and this script proves which one it is:
 *
 *   A) The cookie never reaches the middleware (Next.js strips it, or the
 *      matcher/route-normalisation means a different code path serves the page).
 *   B) The middleware RUNS but resolves a different secret than the API route,
 *      so verifyToken() returns null and it redirects.
 *
 * Method: hit /licenses the way the browser does, but with a token signed with a
 * WRONG secret. If the response is still 307 (redirect to login), the middleware
 * is not distinguishing valid from invalid tokens at all — proving (A): it is
 * not seeing the cookie. If a wrong-secret token and a right-secret token
 * produce the SAME result, the middleware is not the thing rejecting us.
 *
 * Run: node scripts/diagnose-middleware.js
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

function keyFrom(secret) {
  return Buffer.from(secret, "hex").length >= 32
    ? Buffer.from(secret, "hex")
    : Buffer.from(secret.slice(0, 32).padEnd(32, "0"), "utf8");
}

function makeToken(secret, payload) {
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const b = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const s = crypto.createHmac("sha256", keyFrom(secret)).update(`${h}.${b}`).digest("base64url");
  return `${h}.${b}.${s}`;
}

const exp = Math.floor(Date.now() / 1000) + 3600;

/* ── The secret the middleware actually resolved ──────────────────────────────
 *
 * NOT necessarily the one in .env.local. next.config.mjs bakes the signing key
 * into the middleware bundle AT BUILD TIME (env: { SLATE_JWT_SECRET }), and that
 * inlined copy is frozen until the next `npm run build`.
 *
 * So a token signed with today's JWT_SECRET is meaningless to a middleware built
 * before that value existed: the middleware HMACs with the OLD secret, gets a
 * different signature, and redirects — while /api/auth/verify (Node runtime,
 * reads .env.local at request time) happily reports authenticated:true.
 *
 * Two distinct signatures therefore have to be probed separately:
 *   • what the login route / API routes verify with  → today's .env.local value
 *   • what the middleware verifies with              → the build-time value
 *
 * If these differ, a correct login still loops, which is exactly what this
 * script is here to expose. Set SLATE_MW_SECRET (or BUILD_JWT_SECRET) to the key
 * that was live when `npm run build` last ran to reproduce the middleware side.
 * ──────────────────────────────────────────────────────────────────────────── */
const runtimeSecret = env.JWT_SECRET || env.ENCRYPTION_SECRET || "slate-devops-auth-fallback-2026";
const buildSecret =
  process.env.SLATE_MW_SECRET || process.env.BUILD_JWT_SECRET || runtimeSecret;
const badSecret = "0".repeat(96);

const goodToken = makeToken(runtimeSecret, { role: "admin", username: "masterops", exp });
const buildToken = makeToken(buildSecret, { role: "admin", username: "masterops", exp });
const badToken = makeToken(badSecret, { role: "admin", username: "masterops", exp });
const clientToken = makeToken(runtimeSecret, { role: "client", clientId: "x", exp });
const expiredToken = makeToken(runtimeSecret, { role: "admin", username: "masterops", exp: Math.floor(Date.now() / 1000) - 60 });

async function probe(label, cookie) {
  const res = await fetch(`${BASE}/licenses`, {
    headers: cookie ? { Cookie: cookie } : {},
    redirect: "manual",
  });
  const loc = res.headers.get("location") || "";
  console.log(
    `  ${label.padEnd(34)} -> ${res.status}${loc ? "  " + loc : ""}`
  );
  return res.status;
}

(async () => {
  console.log(`\nMiddleware diagnosis against ${BASE}\n`);
  console.log("  Request /licenses with various cookies:\n");

  const anon = await probe("(no cookie)", null);
  const good = await probe("token signed with .env.local key", `slate_session=${goodToken}`);
  const built = await probe("token signed with BUILD-TIME key", `slate_session=${buildToken}`);
  const bad = await probe("INVALID-signature token", `slate_session=${badToken}`);
  const expired = await probe("EXPIRED admin token", `slate_session=${expiredToken}`);
  const client = await probe("client-role token (not admin)", `slate_session=${clientToken}`);

  console.log("\n  Interpretation:");
  if (anon !== 200) console.log("  • Anonymous is correctly blocked.");
  else console.log("  ❌ Anonymous reaches /licenses — the guard is NOT running at all.");

  if (good === 200) {
    console.log("  ✅ A valid admin token is accepted — middleware works.");
  } else if (buildSecret !== runtimeSecret && built === 200) {
    /*
     * The smoking gun. A token signed with the key that was live at BUILD time
     * is accepted, while one signed with today's .env.local key is rejected.
     * The middleware is therefore running and verifying correctly — against a
     * secret the rest of the app stopped using when .env.local changed.
     * The fix is a rebuild, not a code change.
     */
    console.log("  ❌ REBUILD REQUIRED — the middleware is verifying with a STALE key.");
    console.log("     .env.local key      -> " + good + " (rejected)");
    console.log("     build-time key      -> " + built + " (accepted)");
    console.log("     The signing secret was changed (or newly set) after `npm run build`,");
    console.log("     so the inlined middleware copy no longer matches. Run `npm run build`");
    console.log("     and restart — rotating a secret without rebuilding recreates this loop.");
  } else {
    if (bad === good && expired === good && client === good) {
      console.log("  ❌ Valid, invalid, expired AND client tokens ALL produce " + good + ".");
      console.log("     The middleware is not evaluating the cookie at all. Check, in order:");
      console.log("       1. is the middleware bundle the one that is serving this route?");
      console.log("          grep -a 'admin/login' .next/server/middleware.js   # expect 3 hits");
      console.log("       2. does .next/server/middleware-manifest.json list a middleware?");
      console.log("       3. does any other middleware.ts shadow the root one?");
    } else {
      console.log("  ❌ A valid admin token is rejected while other tokens differ");
      console.log("     — signature/secret mismatch between middleware and API routes.");
      console.log("     Cross-check with: node scripts/diagnose-login.js");
    }
  }

  if (client === 200) console.log("  ❌ A CLIENT token can reach an ADMIN page — privilege bug.");
  else console.log("  ✅ A client token cannot reach admin pages.");

  console.log("");

  /*
   * Exiting from inside the fetch() callback trips a libuv assertion on Windows
   * ("!(handle->flags & UV_HANDLE_CLOSING)") because the undici sockets are
   * still being torn down. Set the code and let Node drain naturally instead —
   * the diagnostic's output is not worth a stack-trace-shaped red herring.
   */
  process.exitCode = good === 200 && client !== 200 ? 0 : 1;
})();