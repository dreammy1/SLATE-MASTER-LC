import { NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health — the deploy health check.
 *
 * WHY THIS EXISTS SEPARATELY FROM /api/selftest
 * ---------------------------------------------
 * Render polls healthCheckPath during a deploy and aborts with "Timed Out" if
 * the endpoint does not answer quickly. /api/selftest is a thorough diagnostic
 * and deliberately expensive: it generates 2000 licence keys to prove
 * uniqueness, zips the release bundle, and reads the storage adapter. On a cold
 * free-tier container — fresh container, no JIT warm, first Upstash round-trip
 * — that is several seconds of work, which is exactly the case Render runs the
 * check in. Pointing the health check at it failed a build that was otherwise
 * completely healthy.
 *
 * This route answers the one question the deploy actually asks — "is the
 * process up and able to serve?" — and nothing else. It touches no crypto, no
 * filesystem, and no network, so it returns in single-digit milliseconds and
 * cannot be slowed down by a third party.
 *
 * The full suite is still worth running, just not as the gate:
 *   - /api/selftest        deep diagnostic, unauthenticated, slower
 *   - npm run selftest     same checks from your machine against a base URL
 */
export async function GET() {
  return NextResponse.json(
    {
      status: "ok",
      // Liveness only. A timestamp is enough to confirm the process is not
      // wedged; uptime semantics are deliberately not implied here.
      time: new Date().toISOString(),
    },
    { status: 200, headers: { "cache-control": "no-store" } }
  );
}
