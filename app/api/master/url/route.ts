import { NextRequest, NextResponse } from "next/server";
import { resolveMasterOrigin } from "@/lib/masterOrigin";

/**
 * GET /api/master/url
 *
 * Reports whether Master has a PUBLIC address that clients can reach.
 *
 * The customer's browser performs the activation handshake, so a loopback URL
 * (the normal development value) can never work — it resolves to the customer's
 * own machine and shows "Failed to fetch". This endpoint lets the console warn
 * about that before a deploy, instead of leaving support to debug it from the
 * customer's side.
 */
export async function GET(req: NextRequest) {
  const res = resolveMasterOrigin(req.url);
  return NextResponse.json({
    ok: Boolean(res.origin),
    origin: res.origin,
    loopback: res.loopback,
    message: res.message,
  });
}