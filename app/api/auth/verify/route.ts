import { NextRequest, NextResponse } from "next/server";
import { extractSession, isAdmin, isClient } from "@/lib/auth";

/**
 * GET /api/auth/verify
 * Returns the current session if valid.
 * Query param: ?role=admin|client  — optional, checks role match.
 */
export async function GET(req: NextRequest) {
  const session = extractSession(req);

  if (!session) {
    return NextResponse.json(
      { authenticated: false, error: "No valid session." },
      { status: 401 }
    );
  }

  const { searchParams } = new URL(req.url);
  const role = searchParams.get("role");

  if (role === "admin" && !isAdmin(session)) {
    return NextResponse.json({ authenticated: false, error: "Admin session required." }, { status: 403 });
  }
  if (role === "client" && !isClient(session)) {
    return NextResponse.json({ authenticated: false, error: "Client session required." }, { status: 403 });
  }

  return NextResponse.json({
    authenticated: true,
    role: session.role,
    username: session.username,
    clientId: session.clientId,
    siteUrl: session.siteUrl,
  });
}
