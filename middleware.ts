import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { extractSession, isAdmin, isClient } from "@/lib/auth";
import { decideApiAccess } from "@/lib/apiPolicy";

/*
 * NOTE: there is deliberately NO `export const runtime = "nodejs"` here.
 *
 * It used to say "Force Node.js runtime (lib/auth.ts uses Node's crypto module)",
 * but Next.js ignores that for middleware — middleware ALWAYS runs in the
 * restricted runtime — so the declaration achieved nothing except the illusion
 * that lib/auth.ts had Node's crypto and Buffer available to it. It did not,
 * which is precisely how the login loop survived so long (see lib/auth.ts).
 *
 * lib/auth.ts now uses the Web Crypto API, which is present in every runtime,
 * so the guard no longer has any Node-only dependency to declare.
 */

/**
 * Next.js Middleware — route guard for admin & client areas AND the API.
 *
 *   /admin/*         → requires admin session (else redirect to /admin/login)
 *   /licenses, /sites, /packages, /migrations,
 *   /settings/*, /integrations → requires admin session
 *
 *   /client/*        → requires client session (else redirect to /client/login)
 *
 *   /api/*           → decided by lib/apiPolicy.ts, DENY BY DEFAULT: admin
 *                      session unless the route is explicitly public (checkout,
 *                      order tracking, license heartbeat, webhooks, login) or a
 *                      client reading its own record. Rejections are JSON
 *                      401/403 rather than redirects.
 *
 * Public routes (no session needed):
 *   /, /pricing, /admin/login, /client/login, /_next/*, /favicon.ico,
 *   and the /api routes listed as public in lib/apiPolicy.ts.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  /* ── API: enforced centrally, never left to individual handlers ── */
  if (pathname.startsWith("/api/") || pathname === "/api") {
    const decision = decideApiAccess(req.method, pathname, {
      devOnlyOpen: process.env.NODE_ENV !== "production",
    });
    if (decision.access === "public") return NextResponse.next();

    const session = extractSession(req);
    if (isAdmin(session)) return NextResponse.next();

    if (decision.access === "client-own" && isClient(session)) {
      const owns =
        !!decision.ownerId &&
        (decision.ownerId === session?.clientId || decision.ownerId === session?.licenseId);
      if (owns) return NextResponse.next();
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }

    return NextResponse.json(
      { success: false, error: "Authentication required." },
      { status: session ? 403 : 401 }
    );
  }

  /* ── Public / static / login pages ── */
  if (
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname === "/" ||
    pathname === "/pricing" ||
    pathname === "/admin/login" ||
    pathname === "/client/login"
  ) {
    return NextResponse.next();
  }

  /* ── Client area (except /client/login) ── */
  if (pathname.startsWith("/client")) {
    const session = extractSession(req);
    if (!isClient(session)) {
      return NextResponse.redirect(new URL("/client/login", req.url));
    }
    return NextResponse.next();
  }

  /* ── Admin area: /admin/* and core dashboard pages ── */
  const adminPages = [
    "/admin", "/licenses", "/sites", "/packages",
    "/migrations", "/integrations", "/settings",
  ];
  const isAdminPage =
    pathname.startsWith("/admin") ||
    adminPages.some((p) => pathname === p || pathname.startsWith(p + "/"));

  if (isAdminPage) {
    const session = extractSession(req);
    if (!isAdmin(session)) {
      return NextResponse.redirect(new URL("/admin/login", req.url));
    }
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all paths EXCEPT static assets and public pages. API routes ARE
     * matched now: they are authorised centrally by lib/apiPolicy.ts.
     * Next.js middleware runs on the Edge runtime — keep it lightweight.
     */
    "/((?!_next|favicon.ico|pricing|$).*)",
  ],
};