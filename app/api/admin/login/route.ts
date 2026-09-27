import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin, createToken, createSessionCookie } from "@/lib/auth";

/**
 * POST /api/admin/login
 * Body: { username, password }
 * Sets a session cookie and returns { ok: true } on success.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { username, password } = body;

    if (!username || !password) {
      return NextResponse.json(
        { success: false, error: "Username and password are required." },
        { status: 400 }
      );
    }

    if (!authenticateAdmin(username, password)) {
      return NextResponse.json(
        { success: false, error: "Invalid credentials." },
        { status: 401 }
      );
    }

    const token = createToken({
      role: "admin",
      username: username,
      exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 7 days
    });

    const res = NextResponse.json({ success: true, role: "admin", message: "Logged in." });
    res.headers.set("Set-Cookie", createSessionCookie(token, req));
    return res;
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || "Login failed." },
      { status: 500 }
    );
  }
}
