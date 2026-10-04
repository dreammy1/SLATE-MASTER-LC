/**
 * API access policy — the single source of truth for who may call /api/*.
 *
 * WHY THIS EXISTS
 * ---------------
 * middleware.ts used to wave every `/api/*` request through with the comment
 * "API routes secure themselves per-handler". They did not: apart from the
 * login/verify/logout routes, no handler checked a session. An anonymous caller
 * could list every order (customer PII), approve a manual order as paid, reveal
 * license keys, issue/revoke licenses, read and rewrite the Stripe/SMTP
 * integration settings, and trigger deployments.
 *
 * The policy is DENY BY DEFAULT: a route that is not explicitly listed as
 * public below requires an admin session. A newly added route is therefore
 * protected until someone deliberately opens it here, in code review.
 *
 * This module is pure (no Node APIs) so it runs in the Edge middleware runtime.
 */

export type ApiAccess =
  /** Reachable without a session — either public by design, or it carries its
   *  own credential (signature, license key, token, order capability). */
  | "public"
  /** Requires an admin session. */
  | "admin"
  /** Admin, or a client session that owns the `[id]` in the path (read-only). */
  | "client-own";

export interface ApiDecision {
  access: ApiAccess;
  /** Human-readable reason, surfaced in docs/tests (never to callers). */
  why: string;
  /** For "client-own": the record id in the path the session must own. */
  ownerId?: string;
}

interface PublicRule {
  methods: string[];
  /** Matches the pathname after normalisation (no trailing slash). */
  pattern: RegExp;
  why: string;
}

const PUBLIC_RULES: PublicRule[] = [
  // ── authentication entry points ────────────────────────────────────────
  { methods: ["POST"], pattern: /^\/api\/admin\/login$/, why: "admin sign-in (rate limited in handler)" },
  { methods: ["POST"], pattern: /^\/api\/client\/login$/, why: "client sign-in (rate limited in handler)" },
  { methods: ["POST"], pattern: /^\/api\/auth\/logout$/, why: "clears the caller's own cookie" },
  { methods: ["GET"], pattern: /^\/api\/auth\/verify$/, why: "reports the caller's own session" },

  // ── public storefront ──────────────────────────────────────────────────
  { methods: ["GET"], pattern: /^\/api\/packages$/, why: "public pricing catalogue" },
  { methods: ["GET"], pattern: /^\/api\/plugins\/catalog$/, why: "public plugin catalogue" },
  { methods: ["GET"], pattern: /^\/api\/master\/url$/, why: "public Master origin used by activate.php" },
  { methods: ["GET"], pattern: /^\/api\/health$/, why: "liveness probe" },
  { methods: ["POST"], pattern: /^\/api\/master\/checkout\/session$/, why: "checkout session (validates its own tenant token)" },
  { methods: ["GET", "PUT"], pattern: /^\/api\/master\/checkout\/profile$/, why: "checkout profile (validates its own tenant token)" },

  // ── order flow: the customer has no login, the order id is the capability ─
  { methods: ["POST"], pattern: /^\/api\/orders$/, why: "customer places an order" },
  { methods: ["GET", "POST", "PATCH"], pattern: /^\/api\/orders\/[^/]+$/, why: "order tracking; PATCH additionally requires the order email" },
  { methods: ["GET", "POST"], pattern: /^\/api\/orders\/[^/]+\/(deploy|test-connection|invoice|download-auth|cpanel-health)$/, why: "installer widget for one order id" },

  // ── remote Slate installs and third parties, each with its own credential ─
  { methods: ["POST"], pattern: /^\/api\/deploy\/bootstrap$/, why: "order bootstrap setup (validates orderId in handler)" },
  { methods: ["POST", "OPTIONS"], pattern: /^\/api\/licenses\/(activate|heartbeat|update-request)$/, why: "called by client sites; authenticated by license key hash" },
  { methods: ["POST", "OPTIONS"], pattern: /^\/api\/deploy\/full-install$/, why: "activate.php install; authenticated by license key" },
  { methods: ["POST"], pattern: /^\/api\/deploy\/webhook$/, why: "GitHub Actions; authenticated by X-Slate-Token" },
  { methods: ["POST"], pattern: /^\/api\/stripe\/webhook$/, why: "Stripe; authenticated by webhook signature" },
];

/** Trim a trailing slash so `/api/orders/` and `/api/orders` are one route. */
export function normalizeApiPath(pathname: string): string {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return p || "/";
}

/**
 * Decide the access level for an API request.
 *
 * @param devOnlyOpen when true (non-production), the self-test endpoint is open
 *        so `npm run selftest` keeps working locally. It is admin-only in
 *        production because it reports on the server's configuration.
 */
export function decideApiAccess(
  method: string,
  pathname: string,
  opts: { devOnlyOpen?: boolean } = {}
): ApiDecision {
  const m = method.toUpperCase();
  const path = normalizeApiPath(pathname);

  for (const rule of PUBLIC_RULES) {
    if (rule.pattern.test(path) && rule.methods.includes(m)) {
      return { access: "public", why: rule.why };
    }
  }

  if (opts.devOnlyOpen && m === "GET" && path === "/api/selftest") {
    return { access: "public", why: "self-test (non-production only)" };
  }

  // A client may READ its own record (dashboard + "reveal my key"); nothing
  // else under /api/clients, because PATCH there edits license status/expiry.
  const own = path.match(/^\/api\/clients\/([^/]+)$/);
  if (own && m === "GET") {
    return { access: "client-own", why: "client reads their own record", ownerId: decodeURIComponent(own[1]) };
  }

  return { access: "admin", why: "default: admin session required" };
}
