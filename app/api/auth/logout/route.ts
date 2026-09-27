import { NextRequest, NextResponse } from "next/server";
import { createClearCookie } from "@/lib/auth";

/**
 * POST /api/auth/logout
 * Clears the session cookie.
 *
 * The request is forwarded so the clearing cookie uses the same `Secure`
 * attribute as the one being replaced; a browser rejects a Set-Cookie whose
 * attributes it deems invalid for the connection, which would silently leave
 * the session in place.
 */
export async function POST(req: NextRequest) {
  const res = NextResponse.json({ success: true, message: "Logged out." });
  res.headers.set("Set-Cookie", createClearCookie(req));
  return res;
}
