import crypto from "crypto";

/* ─────────────────────────────────────────────────────────────────────────
 * SLATE DevOps OS — Authentication & Session Layer
 *
 * • Admin auth → username/password from environment (hardcoded safe fallback)
 * • Client auth → license key (SLT-xxxx-xxxx-xxxx-xxxx) + email match
 * • Tokens are signed HMAC-SHA256 (no external JWT library required)
 * • Sessions stored in-memory (restart-safe via the JWT payload itself)
 * ───────────────────────────────────────────────────────────────────────── */

export type SessionRole = "admin" | "client";

export interface SessionPayload {
  role: SessionRole;
  username?: string;      // admin
  clientId?: string;      // client (order id)
  licenseId?: string;     // client (license id)
  siteUrl?: string;       // client (site)
  exp: number;            // unix timestamp
}

const TOKEN_COOKIE = "slate_session";
const TOKEN_MAX_AGE = 7 * 24 * 60 * 60; // 7 days

/* ── Secret ──────────────────────────────────────────────────────────────
 *
 * ── A correction to what this comment used to claim ────────────────────────
 *
 * This block previously blamed the login loop on a SECRET MISMATCH between the
 * two runtimes: it asserted that the middleware bundle's environment lost
 * ENCRYPTION_SECRET, fell back to the hardcoded literal below, and therefore
 * computed a different HMAC than the login route.
 *
 * That was wrong, and it was disproved rather than argued away. Rebuilding the
 * app, and then signing tokens with every candidate secret in turn (the
 * .env.local JWT_SECRET, ENCRYPTION_SECRET, and the fallback literal), each
 * produced the same redirect. A secret mismatch cannot explain a token that the
 * middleware rejects even when signed with the middleware's own fallback key.
 *
 * The real cause was the CRYPTO CALL ITSELF failing inside the middleware
 * runtime — see the SHA-256/HMAC note further down. The secret resolution below
 * was never the problem; it is kept eager (and the variable is still read at
 * module load) because that part is genuinely sound and cheap.
 *
 * The lesson worth keeping: when evidence contradicts an explanation, the
 * explanation goes — including one written into a comment for future readers.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Name of the variable that next.config.mjs bakes into the middleware bundle.
 * Kept in sync with the `env:` block there deliberately; the middleware cannot
 * read the process environment the way a route handler can.
 */
/**
 * Name of the variable that next.config.mjs TRIES to bake into the middleware
 * bundle. See next.config.mjs for the honest status of that inlining — it does
 * not reliably happen, which is exactly why nothing here may depend on it being
 * present.
 */
const MIDDLEWARE_SECRET_VAR = "SLATE_JWT_SECRET";

/**
 * The secret used to sign and verify session tokens.
 *
 * Resolution order:
 *   1. SLATE_JWT_SECRET  — meant to be inlined by next.config.mjs. Do not rely
 *                          on it arriving; treat it as an optional override.
 *   2. JWT_SECRET        — the documented, dedicated variable.
 *   3. ENCRYPTION_SECRET — existing installs that never set JWT_SECRET.
 *   4. a fixed literal   — development convenience only.
 *
 * In a route handler this resolves against the real process environment. In the
 * middleware it resolves against whatever Next.js injects — which, in practice,
 * has been nothing, so the fallback was in use there. That is now harmless, and
 * was never actually the requirement it appeared to be: the two runtimes only
 * need to agree when they are asked to verify the SAME token. They do not, as it
 * happens — see the crypto note below for what was really going wrong.
 */
function resolveJwtSecret(): string {
  return (
    process.env[MIDDLEWARE_SECRET_VAR] ||
    process.env.JWT_SECRET ||
    process.env.ENCRYPTION_SECRET ||
    "slate-devops-auth-fallback-2026"
  );
}

/**
 * Resolved ONCE at module load. Cheap and deliberate: reading it once keeps the
 * hot path free of environment lookups, and there is no correctness dependency
 * on when it happens.
 */
const JWT_SECRET = resolveJwtSecret();

/**
 * Derive the raw HMAC key bytes from the resolved secret.
 *
 * A 64-char hex string is decoded as hex (32 bytes); anything else is used as
 * UTF-8, padded or truncated to 32 bytes. Implemented without Buffer so it
 * yields identical bytes in the Node and middleware runtimes.
 */
function getJwtSecret(): Uint8Array {
  const env = JWT_SECRET;

  // Treat the value as hex only when it really is hex AND long enough to be a
  // key — mirrors the previous Buffer.from(env, "hex") length check.
  if (/^[0-9a-fA-F]+$/.test(env) && env.length >= 64) {
    const bytes = new Uint8Array(env.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(env.substr(i * 2, 2), 16);
    }
    return bytes;
  }

  return utf8ToBytes(env.slice(0, 32).padEnd(32, "0"));
}

/* ── SHA-256 + HMAC, implemented in pure JavaScript ──────────────────────────
 *
 * This looks like wheel-reinvention, and in any other file it would be. Here it
 * is the only thing that actually works, for a reason that took far too long to
 * find:
 *
 * Next.js middleware does NOT run on Node. It is evaluated in a sandbox whose
 * `crypto` module (webpack module 440, `node:crypto` shimmed for the edge
 * runtime) provides createHmac but NOT `subtle`. So:
 *
 *   • `crypto.createHmac(...)`  — present, but its result is discarded by the
 *                                 base64url/Buffer path that follows it
 *   • `crypto.subtle.*`         — undefined; throws inside verifyToken()'s try
 *                                 block and is swallowed into `return null`
 *
 * Both routes fail identically and silently: the guard redirects every request,
 * the login endpoint returns 200, and /api/auth/verify (a Node route, where
 * every one of these APIs works) reports the session as valid.
 *
 * The algorithm below has no dependencies at all, so there is nothing for the
 * two runtimes to disagree about. It is verified against node:crypto's output in
 * scripts/verify-token-crypto.js — run that after touching any of this.
 * ──────────────────────────────────────────────────────────────────────────── */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function sha256(message: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const bitLen = message.length * 8;
  const withPadding = new Uint8Array(Math.ceil((message.length + 9) / 64) * 64);
  withPadding.set(message);
  withPadding[message.length] = 0x80;
  const view = new DataView(withPadding.buffer);
  view.setUint32(withPadding.length - 4, bitLen >>> 0, false);
  view.setUint32(withPadding.length - 8, Math.floor(bitLen / 0x100000000), false);

  const w = new Uint32Array(64);

  for (let offset = 0; offset < withPadding.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    // Read the eight working variables by index — destructuring a Uint32Array
    // needs --downlevelIteration, and this file targets a lower ES level.
    let a = h[0], b = h[1], c = h[2], d = h[3];
    let e = h[4], f = h[5], g = h[6], hh = h[7];

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;

      hh = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i], false);
  return out;
}

function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const blockSize = 64;
  let keyBlock = key;
  if (keyBlock.length > blockSize) keyBlock = sha256(keyBlock);

  const padded = new Uint8Array(blockSize);
  padded.set(keyBlock);

  const innerPad = new Uint8Array(blockSize);
  const outerPad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    innerPad[i] = padded[i] ^ 0x36;
    outerPad[i] = padded[i] ^ 0x5c;
  }

  const inner = sha256(concatBytes(innerPad, message));
  return sha256(concatBytes(outerPad, inner));
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/* ── Admin credentials ── */
export interface AdminConfig {
  username: string;
  password: string;
}
export function getAdminConfig(): AdminConfig {
  return {
    username: process.env.ADMIN_USERNAME || "masterops",
    password: process.env.ADMIN_PASSWORD || "#Admin_ops#",
  };
}

/* ── Token creation / verification (HMAC-SHA256) ──
 *
 * ⚠️  These use the WEB CRYPTO API, not node:crypto, and that is deliberate.
 *
 * The original implementation called crypto.createHmac() and Buffer.from(x,
 * "base64url"). That code works perfectly in a route handler and fails inside
 * middleware, which does NOT run on Node: Next.js executes middleware in a
 * restricted VM whose Buffer is a PARTIAL polyfill. `Buffer.from(str,
 * "base64url")` exists there but does not decode URL-safe input the way Node's
 * does, so the signature comparison at the end of verifyToken() compared two
 * different byte sequences and returned null.
 *
 * The symptom was exquisitely confusing and is worth recording:
 *
 *   • POST /api/admin/login            -> 200, Set-Cookie issued
 *   • GET  /api/auth/verify            -> 200 {"authenticated":true}
 *   • GET  /licenses                   -> 307 /admin/login, FOREVER
 *
 * Same cookie, same secret, same verification code — a different answer from
 * each runtime, because the two runtimes do not share a Buffer implementation.
 * Nothing threw, because verifyToken() swallows every error into `return null`,
 * and a wrong signature is indistinguishable from a forged one by design.
 *
 * Web Crypto's HMAC and its base64url handling behave identically everywhere,
 * so the key and the comparison cannot drift between the two runtimes.
 * ─────────────────────────────────────────────────────────────────────────── */

/** base64url-encode bytes (no padding), the JWT representation. */
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode base64url / base64 text into bytes, tolerating missing padding. */
function base64UrlToBytes(value: string): Uint8Array {
  const normalised = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalised + "=".repeat((4 - (normalised.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** UTF-8 encode without depending on Node's Buffer. */
function utf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Constant-time comparison of two byte arrays. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Signs `${header}.${body}`, returning the base64url third segment.
 *
 * Synchronous by nature — no Web Crypto, no node:crypto — which is the point:
 * there is no runtime-specific primitive left to be missing.
 */
function signSegments(header: string, body: string): string {
  const signature = hmacSha256(getJwtSecret(), utf8ToBytes(`${header}.${body}`));
  return bytesToBase64Url(signature);
}

export function createToken(payload: SessionPayload): string {
  const header = bytesToBase64Url(utf8ToBytes(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = bytesToBase64Url(utf8ToBytes(JSON.stringify(payload)));
  return `${header}.${body}.${signSegments(header, body)}`;
}

export function verifyToken(token: string): SessionPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [header, body, sig] = parts;
    const expectedSig = signSegments(header, body);

    if (!bytesEqual(base64UrlToBytes(sig), base64UrlToBytes(expectedSig))) {
      return null;
    }
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(body))) as SessionPayload;
    if (payload.exp && Date.now() > payload.exp * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ── Admin sign-in ── */
export function authenticateAdmin(username: string, password: string): boolean {
  const cfg = getAdminConfig();
  // Use timing-safe comparison to prevent timing attacks
  const userMatch = crypto.timingSafeEqual(Buffer.from(username, "utf8"), Buffer.from(cfg.username, "utf8"));
  const passMatch = crypto.timingSafeEqual(Buffer.from(password, "utf8"), Buffer.from(cfg.password, "utf8"));
  return userMatch && passMatch;
}

/* ── Client sign-in (license key + email) ── */
export interface ClientAuthResult {
  ok: boolean;
  orderId?: string;
  licenseId?: string;
  siteUrl?: string;
  message: string;
}

export async function authenticateClient(licenseKey: string, email: string): Promise<ClientAuthResult> {
  const db = await import("./storage").then(m => m.getDb());
  const { hashLicenseKey } = await import("./licensing");

  const keyHash = hashLicenseKey(licenseKey.trim().toUpperCase());

  // 1. Match against licenses by key_hash
  const license = db.licenses.find(l => l.key_hash === keyHash);
  if (!license) {
    return { ok: false, message: "Invalid license key." };
  }

  // 2. Match the email against the order's contact email
  if (license.orderId) {
    const order = db.orders.find(o => o.id === license.orderId);
    if (!order || order.contactEmail.toLowerCase() !== email.toLowerCase()) {
      return { ok: false, message: "Email does not match this license." };
    }
    return {
      ok: true,
      orderId: order.id,
      licenseId: license.id,
      siteUrl: order.siteUrl,
      message: "Client authenticated.",
    };
  }

  // Fallback: license without orderId but has domain
  return {
    ok: true,
    licenseId: license.id,
    siteUrl: license.domain,
    message: "Client authenticated.",
  };
}

/* ── Cookie helpers ── */
export function getCookieFromHeaders(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`${TOKEN_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

/**
 * Should the session cookie carry the `Secure` attribute?
 *
 * ── The bug this fixes ──────────────────────────────────────────────────────
 *
 * This used to be `process.env.NODE_ENV === "production"`. On a production build
 * served over plain HTTP — which is exactly what `npm run build && npm start`
 * gives you at http://localhost:3000, and what a bare-IP VPS deploy gives you —
 * the server sent `Secure` on an HTTP response. Browsers SILENTLY DISCARD a
 * Secure cookie received over HTTP, so the login endpoint returned 200 but the
 * session never persisted: the middleware found no cookie and redirected
 * /licenses back to /admin/login forever. Login appeared to "do nothing".
 *
 * The attribute must be driven by the protocol the browser actually used, not by
 * the build mode. A cookie is only allowed to be Secure when the request that
 * set it arrived over HTTPS — which includes a request that reached us through
 * a TLS-terminating proxy (Cloudflare, Render, nginx), which is why the
 * forwarded-proto header is checked before the request URL scheme.
 *
 * Worse, marking a plain-HTTP cookie Secure on a LAN IP or a dev host would make
 * the dashboard permanently impossible to sign into, with no error message to
 * explain why.
 *
 * @param req The incoming request, when available. Omit to get a
 *            protocol-agnostic cookie (used by the logout clearer, where a
 *            mismatched attribute could leave a stale cookie behind).
 */
export function shouldUseSecureCookie(req?: Request): boolean {
  if (!req) return false;

  // A TLS-terminating proxy reports the ORIGINAL scheme here. Cloudflare sends
  // "https", and so do Render, Fly and Vercel. The left-most value is the
  // client-facing one when a chain of proxies is involved.
  const forwardedProto = req.headers.get("x-forwarded-proto");
  if (forwardedProto) {
    return forwardedProto.split(",")[0].trim().toLowerCase() === "https";
  }

  // No proxy in front of us: trust the URL we were actually reached on.
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function createSessionCookie(token: string, req?: Request): string {
  return `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TOKEN_MAX_AGE}; ${
    shouldUseSecureCookie(req) ? "Secure;" : ""
  }`;
}

/**
 * Clears the session cookie.
 *
 * Deliberately omits `Secure` so it always matches the cookie it is clearing:
 * browsers match a cookie for deletion on name+path+domain, but sending Secure
 * on a plain-HTTP response makes the browser reject the whole Set-Cookie header,
 * which would leave the user logged in after clicking "log out".
 */
export function createClearCookie(req?: Request): string {
  return `${TOKEN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; ${
    shouldUseSecureCookie(req) ? "Secure;" : ""
  }`;
}

/**
 * Extract the session from either a standard Request or NextRequest.
 *
 * Next middleware exposes parsed cookies through `req.cookies`; depending on
 * the Next.js/runtime adapter, the raw `Cookie` header may not be present in
 * `req.headers`. Route handlers normally have the header, so support both
 * access paths without making the authentication layer depend on Next.js.
 */
export function extractSession(req: Request): SessionPayload | null {
  const nextCookies = (req as Request & {
    cookies?: { get?: (name: string) => { value: string } | undefined };
  }).cookies;
  const parsedToken = nextCookies?.get?.(TOKEN_COOKIE)?.value;
  const headerToken = getCookieFromHeaders(req.headers.get("cookie"));
  const token = parsedToken || headerToken;
  return token ? verifyToken(token) : null;
}

/* ── Check if admin is logged in ── */
export function isAdmin(session: SessionPayload | null): boolean {
  return !!session && session.role === "admin";
}

/* ── Check if client is logged in ── */
export function isClient(session: SessionPayload | null): boolean {
  return !!session && session.role === "client";
}
