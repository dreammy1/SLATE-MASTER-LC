import { NextRequest, NextResponse } from "next/server";

/** Stripe webhook stub (manual-first). Verifies signature when STRIPE_WEBHOOK_SECRET is set; marks matching order paid. */
export async function POST(req: NextRequest) {
  try {
    const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
    const sig = req.headers.get("stripe-signature") || "";
    const raw = await req.text();
    if (secret) {
      const crypto = await import("crypto");
      const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
      if (sig !== expected && !sig.includes(expected)) {
        return NextResponse.json({ success: false, error: "Bad webhook signature." }, { status: 400 });
      }
    }
    let event: any = {};
    try { event = JSON.parse(raw); } catch { event = {}; }
    // Idempotency: stripe_session_id / event.id
    const sessionId: string = event?.data?.object?.id || event?.id || "";
    const orderId: string = event?.data?.object?.metadata?.orderId || event?.orderId || "";
    if (orderId) {
      const { getOrder, updateOrder } = await import("@/lib/storage");
      const order = await getOrder(orderId);
      if (order && order.status !== "paid") {
        if (sessionId && order.stripe_session_id && order.stripe_session_id === sessionId) {
          return NextResponse.json({ success: true, deduped: true });
        }
        await updateOrder(orderId, { status: "paid", stripe_session_id: sessionId || undefined });
      }
      return NextResponse.json({ success: true, orderId });
    }
    return NextResponse.json({ success: true, received: true, note: "No orderId in metadata — manual approve path." });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
