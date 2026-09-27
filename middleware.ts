import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { extractSession, isAdmin, isClient } from "@/lib/auth";

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
 * Next.js Middleware — route guard for admin & client areas.
 *
 *   /admin/*         → requires admin session (else redirect to /admin/login)
 *   /licenses, /sites, /packages, /migrations,
 *   /settings/*, /integrations → requires admin session
 *
 *   /client/*        → requires client session (else redirect to /client/login)
 *
 * Public routes (no session needed):
 *   /, /pricing, /admin/login, /client/login, /_next/*, /favicon.ico,
 *   /api/* (API routes handle their own auth in handlers)
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  /* ── Public / static / login pages ── */
  if (
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname === "/" ||
    pathname === "/pricing" ||
    pathname === "/admin/login" ||
    pathname === "/client/login" ||
    pathname.startsWith("/api/")  /* API routes secure themselves per-handler */
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
     * Match all paths EXCEPT static assets, public pages, and API routes.
     * Next.js middleware runs on the Edge runtime — keep it lightweight.
     */
    "/((?!_next|favicon.ico|api/|pricing|$).*)",
  ],
};