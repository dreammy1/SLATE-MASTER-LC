import { NextRequest, NextResponse } from "next/server";
import { createToken, authenticateClient, createSessionCookie } from "@/lib/auth";

/**
 * POST /api/client/login
 * Body: { license_key, email }
 * Sets a session cookie and returns { ok: true, client } on success.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { license_key, email } = body;

    if (!license_key || !email) {
      return NextResponse.json(
        { success: false, error: "License key and email are required." },
        { status: 400 }
      );
    }

    const result = await authenticateClient(license_key, email);

    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: result.message },
        { status: 401 }
      );
    }

    const token = createToken({
      role: "client",
      clientId: result.orderId,
      licenseId: result.licenseId,
      siteUrl: result.siteUrl,
      exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
    });

    const res = NextResponse.json({
      success: true,
      role: "client",
      client: {
        orderId: result.orderId,
        licenseId: result.licenseId,
        siteUrl: result.siteUrl,
      },
      message: result.message,
    });
    res.headers.set("Set-Cookie", createSessionCookie(token, req));
    return res;
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || "Login failed." },
      { status: 500 }
    );
  }
}
