import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { isCollectedPaymentEvent, markOrderPaid } from "@/lib/stripeFulfillment";

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY || "dummy_key_for_webhook_signature";
  return new Stripe(key, { apiVersion: "2023-10-16" as any });
}

/** Stripe webhook: Verifies signature, avoids replay attacks, and marks matching order paid. */
export async function POST(req: NextRequest) {
  try {
    const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
    const sig = req.headers.get("stripe-signature") || "";
    const raw = await req.text();
    let event: Stripe.Event;

    if (secret && sig) {
      try {
        const stripe = getStripe();
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

    if (event.type === "checkout.session.completed" && dataObj?.payment_status !== "paid") {
      return NextResponse.json({ success: true, received: true, note: "Session completed but payment not yet collected." });
    }

    if (isCollectedPaymentEvent(event.type, dataObj?.payment_status) && orderId) {
      // PaymentIntent IDs and Checkout Session IDs are different identifiers
      // for the same payment. Bind the order only to the session identifier;
      // PaymentIntent success remains a valid fulfillment signal without
      // creating a false "conflicting session" on the later session event.
      const checkoutSessionId = event.type.startsWith("checkout.session.") ? sessionId : "";
      const result = await markOrderPaid(orderId, checkoutSessionId);
      if (result.kind === "ignored" && result.reason === "conflicting_session") {
        return NextResponse.json({ success: false, error: "Order is already bound to a different Stripe transaction." }, { status: 409 });
      }
      if (result.kind === "ignored" && result.reason === "cancelled") {
        return NextResponse.json({ success: true, ignored: true, reason: "cancelled", orderId });
      }
      if (result.kind === "ignored" && result.reason === "missing_order") {
        return NextResponse.json({ success: true, received: true, note: "No matching order found." });
      }
      return NextResponse.json({ success: true, orderId, deduped: result.kind === "deduped" });
    }
    
    return NextResponse.json({ success: true, received: true, note: "Unhandled event type or missing orderId." });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
