/**
 * Resolving the PUBLIC Master URL — the address the CLIENT's browser and the
 * client's server must be able to reach.
 *
 * This is not "the URL I happen to be serving on". During development Master
 * runs at http://localhost:3000, and that value was being written into the
 * client's .slate_agent_config.json and activate.php. The customer's browser then
 * dutifully called localhost — its own machine — and got "Failed to fetch" while
 * Master was perfectly healthy.
 *
 * Loopback is therefore never a valid answer here: if it is all we have, we say so
 * loudly rather than silently handing the client a broken address.
 */

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i;

/**
 * Public URLs that managed hosts inject into the environment for us.
 *
 * Every one of these is a real, externally reachable origin, so adopting it
 * removes a manual copy step — and a chance to get it wrong — when deploying to
 * Render, Vercel, Fly or Cloud Run. They are appended AFTER the explicit
 * MASTER_PUBLIC_URL candidates, so a self-hosted install is never affected.
 *
 * VERCEL_URL and FLY_APP_NAME carry a bare hostname rather than a scheme, and
 * VERCEL_URL is auto-detected as production by VERCEL_ENV; `toOrigin` handles
 * the missing scheme and the host-only form is resolved over https below.
 */
function platformUrlCandidates(): string[] {
  const out: string[] = [];

  // Render: the full public URL of the service.
  if (process.env.RENDER_EXTERNAL_URL) out.push(process.env.RENDER_EXTERNAL_URL);

  // Vercel: VERCEL_URL is host-only. Prefer the stable production domain when
  // Vercel provides one; the deployment-specific URL is fine as a fallback.
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    out.push(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`);
  }
  if (process.env.VERCEL_URL) out.push(`https://${process.env.VERCEL_URL}`);

  // Fly.io: FLY_APP_NAME is the app slug; APP_NAME lets an operator override.
  if (process.env.FLY_APP_NAME) out.push(`https://${process.env.FLY_APP_NAME}.fly.dev`);

  // Google Cloud Run: K_SERVICE is the service name (no region in it).
  if (process.env.K_SERVICE && process.env.CLOUDSDK_CORE_PROJECT) {
    out.push(`https://${process.env.K_SERVICE}-${process.env.CLOUDSDK_CORE_PROJECT}.run.app`);
  }

  return out;
}

/**
 * Normalise a configured value into a bare ORIGIN.
 *
 * Two real misconfigurations this defends against, both seen in the wild:
 *   http://localhost:3001/licenses   — a loopback host WITH a page path, which
 *                                      slipped past a pattern that only matched
 *                                      bare loopback origins
 *   https://master.example.com/       — harmless trailing slash
 *
 * A path here is always wrong: Master's client-facing endpoints are under
 * /api/..., so ".../licenses" would make the client call
 * ".../licenses/api/deploy/full-install". We keep only the origin.
 */
export function toOrigin(value: string): { origin: string; hadPath: boolean; valid: boolean } {
  const raw = String(value || "").trim();
  if (!raw) return { origin: "", hadPath: false, valid: false };
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return { origin: "", hadPath: false, valid: false };
    const hadPath = u.pathname !== "/" && u.pathname !== "";
    return { origin: u.origin, hadPath, valid: true };
  } catch {
    // Accept a bare host[:port] without a scheme, then re-parse.
    try {
      const u = new URL(`https://${raw}`);
      const hadPath = u.pathname !== "/" && u.pathname !== "";
      return { origin: u.origin, hadPath, valid: true };
    } catch {
      return { origin: "", hadPath: false, valid: false };
    }
  }
}

export function isLoopbackUrl(url: string): boolean {
  const { origin } = toOrigin(url);
  return LOOPBACK.test(origin);
}

export type MasterOriginResult = {
  /** The public origin, or "" when nothing usable is configured. */
  origin: string;
  /** True when the only candidate was a loopback address. */
  loopback: boolean;
  /** True when a configured value was a loopback AND/OR carried a wrong path. */
  misconfigured: boolean;
  message: string;
};

/**
 * Pick the public origin for this Master instance.
 *
 * Order:
 *   1. MASTER_PUBLIC_URL      — explicit, always wins (use this in production)
 *   2. NEXT_PUBLIC_APP_URL    — the app's configured public URL
 *   3. PUBLIC_APP_URL / APP_URL
 *   4. A host-platform URL injected into the environment (see PLATFORM_URL_VARS)
 *   5. the request's own origin, but ONLY when it is not loopback
 *
 * Never falls back to localhost, and never keeps a path component: a value like
 * "http://localhost:3001/licenses" is reduced to its origin for comparison and
 * rejected as loopback. Callers that get origin:"" must stop and tell the
 * operator, because anything written to the client would be unreachable.
 */
export function resolveMasterOrigin(reqUrl?: string): MasterOriginResult {
  const candidates = [
    process.env.MASTER_PUBLIC_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.PUBLIC_APP_URL,
    process.env.APP_URL,
    // On a managed host the platform already knows the public URL it gave us,
    // and telling the operator to copy it by hand is a needless failure point.
    // These are read AFTER the explicit vars so MASTER_PUBLIC_URL still wins,
    // and they are validated by exactly the same loopback/path rules below.
    ...platformUrlCandidates(),
  ].filter(Boolean) as string[];

  let sawLoopback = false;
  let sawPath = false;

  for (const c of candidates) {
    const { origin, hadPath, valid } = toOrigin(c);
    if (!valid || !origin) continue;
    if (hadPath) sawPath = true;
    if (isLoopbackUrl(origin)) {
      sawLoopback = true;
      continue; // never acceptable for a remote client
    }
    return {
      origin,
      loopback: false,
      misconfigured: sawPath,
      message: sawPath
        ? `Using Master URL ${origin} (the configured value contained a path, which was ignored — clients call /api/... directly).`
        : `Using configured Master URL ${origin}.`,
    };
  }

  // The request origin can be correct (e.g. Master deployed behind a real domain).
  if (reqUrl) {
    try {
      const origin = new URL(reqUrl).origin;
      if (!isLoopbackUrl(origin)) {
        return { origin, loopback: false, misconfigured: sawPath, message: `Using request origin ${origin}.` };
      }
    } catch {
      /* ignore malformed */
    }
  }

  const reasons: string[] = [];
  if (sawLoopback) {
    reasons.push(
      "Master is configured with a localhost address, which your clients' browsers cannot reach (localhost means the visitor's own machine)."
    );
  } else {
    reasons.push("No public Master URL is configured.");
  }
  if (sawPath) {
    reasons.push("A configured URL also contained a page path (e.g. /licenses); use the bare origin only.");
  }

  return {
    origin: "",
    loopback: sawLoopback,
    misconfigured: true,
    message: `${reasons.join(" ")} Set MASTER_PUBLIC_URL to the public address of this dashboard, e.g. https://master.yourdomain.com (the address that serves /api/...), then restart Master.`,
  };
}