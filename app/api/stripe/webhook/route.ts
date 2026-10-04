import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getOrder, updateOrder } from "@/lib/storage";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2023-10-16" as any,
});

/** Stripe webhook: Verifies signature, avoids replay attacks, and marks matching order paid. */
export async function POST(req: NextRequest) {
  try {
    const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
    const sig = req.headers.get("stripe-signature") || "";
    const raw = await req.text();
    let event: Stripe.Event;

    if (secret && sig) {
      try {
        event = stripe.webhooks.constructEvent(raw, sig, secret);
      } catch (err: any) {
        return NextResponse.json({ success: false, error: `Webhook signature verification failed: ${err.message}` }, { status: 400 });
      }
    } else {
      // Unsigned events are accepted ONLY when explicitly opted in AND running in
      // development. Previously anything other than NODE_ENV === "production"
      // skipped verification, so a deployment with NODE_ENV unset would let anyone
      // POST a fake "paid" event and get a free license.
      const allowUnsigned =
        process.env.NODE_ENV === "development" && process.env.ALLOW_UNSIGNED_STRIPE_WEBHOOK === "1";
      if (!allowUnsigned) {
        return NextResponse.json({ success: false, error: "Missing stripe-signature or STRIPE_WEBHOOK_SECRET." }, { status: 400 });
      }
      try { event = JSON.parse(raw); } catch { event = {} as Stripe.Event; }
    }

    const dataObj = event.data?.object as any;
    const sessionId: string = dataObj?.id || event.id || "";
    const orderId: string = dataObj?.metadata?.orderId || "";

    if (event.type === "checkout.session.completed" || event.type === "payment_intent.succeeded") {
      // checkout.session.completed also fires for delayed-payment methods (bank
      // debits etc.) BEFORE the money arrives. Only treat the order as paid once
      // Stripe reports it collected; the async-success event covers the rest.
      if (event.type === "checkout.session.completed" && dataObj?.payment_status !== "paid") {
        return NextResponse.json({ success: true, received: true, note: "Session completed but payment not yet collected." });
      }
      if (orderId) {
        const order = await getOrder(orderId);
        if (order) {
          if (order.status === "paid") {
            return NextResponse.json({ success: true, deduped: true }); // Idempotency check: Already paid
          }
          await updateOrder(orderId, { status: "paid", stripe_session_id: sessionId || undefined });
        }
        return NextResponse.json({ success: true, orderId });
      }
    }

    // Delayed-payment methods report success here, later.
    if (event.type === "checkout.session.async_payment_succeeded" && orderId) {
      const order = await getOrder(orderId);
      if (order && order.status !== "paid") {
        await updateOrder(orderId, { status: "paid", stripe_session_id: sessionId || undefined });
      }
      return NextResponse.json({ success: true, orderId });
    }
    
    return NextResponse.json({ success: true, received: true, note: "Unhandled event type or missing orderId." });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
