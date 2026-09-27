/**
 * ─────────────────────────────────────────────────────────────────────────
 *  CORRECTED: what this file claimed, and what actually happens
 * ─────────────────────────────────────────────────────────────────────────
 *
 * This comment used to present the `env` block below as the FIX for the login
 * loop, on the theory that the middleware was losing ENCRYPTION_SECRET from its
 * environment and signing with the wrong key.
 *
 * That theory was wrong, and testing it disproved it rather than confirming it:
 *
 *   • A full rebuild was run. The loop did not go away.
 *   • The compiled .next/server/middleware.js was inspected and found to contain
 *     `process.env.SLATE_JWT_SECRET || process.env.JWT_SECRET || ...` — the
 *     ORIGINAL expression, not an inlined literal. The secret value never made
 *     it into the bundle at all.
 *   • Tokens were then signed with every candidate secret — today's JWT_SECRET,
 *     ENCRYPTION_SECRET, and the hardcoded fallback — and the middleware rejected
 *     all of them identically. If the failure were a wrong-key problem, the token
 *     matching the middleware's own key would have been accepted.
 *
 * So `env` here does not reliably reach middleware in this Next.js version, and
 * the real defect was in lib/auth.ts: the HMAC call itself failed inside the
 * middleware runtime (node:crypto's createHmac result was discarded, and
 * crypto.subtle does not exist there). See the long note in lib/auth.ts.
 *
 * The `env` block is kept because it is harmless and may help in other runtime
 * configurations — but nothing depends on it any more. The session layer no
 * longer needs any runtime-specific crypto or environment behaviour to agree.
 * ─────────────────────────────────────────────────────────────────────────
 */

// Passed through to the bundler's env. Treated as an optional override only:
// lib/auth.ts falls back to JWT_SECRET / ENCRYPTION_SECRET and works regardless
// of whether this value is present.
const SLATE_JWT_SECRET = process.env.JWT_SECRET || process.env.ENCRYPTION_SECRET || "";

if (!SLATE_JWT_SECRET) {
  console.warn(
    "[SLATE] Neither JWT_SECRET nor ENCRYPTION_SECRET is set at build time.\n" +
      "        Sessions will be signed with the shared development fallback. Set\n" +
      "        JWT_SECRET in .env.local for any deployment you log into."
  );
}

/** @type {import("next").NextConfig} */
const nextConfig = {
  // Kept as-is: this app relies on non-idempotent effects in a couple of client
  // components and double-invocation broke the scaffold progress stream.
  reactStrictMode: false,

  // Inlined into BOTH the middleware and Node.js bundles — see the note above.
  env: {
    SLATE_JWT_SECRET,
  },
};

export default nextConfig;
