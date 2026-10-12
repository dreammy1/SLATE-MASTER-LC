import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getOrder, getPackage, updateOrder } from "@/lib/storage";
import { markOrderPaid } from "@/lib/stripeFulfillment";

function getStripeInstance() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key, { apiVersion: "2023-10-16" as any });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const order = await getOrder(id);
    if (!order) {
      return NextResponse.json({ success: false, error: "Order not found." }, { status: 404 });
    }

    const pkg = await getPackage(order.package_id);
    const cycle = order.billing_cycle;
    const amountCents = pkg
      ? cycle === "monthly"
        ? pkg.pricing?.monthly_cents
        : cycle === "yearly"
          ? pkg.pricing?.yearly_cents
          : pkg.pricing?.lifetime_cents
      : 0;

    return NextResponse.json({
      success: true,
      orderId: order.id,
      status: order.status,
      payMethod: order.payMethod,
      packageName: pkg?.name || "Slate Package",
      billing_cycle: order.billing_cycle,
      amountCents: amountCents || 0,
      currency: pkg?.pricing?.currency || "USD",
      stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY),
      publishableKeyConfigured: Boolean(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY),
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const order = await getOrder(id);
    if (!order) {
      return NextResponse.json({ success: false, error: "Order not found." }, { status: 404 });
    }

    if (order.status === "cancelled") {
      return NextResponse.json({ success: false, error: "Order has been cancelled." }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const action = body.action || (body.paymentIntentId ? "confirm" : "create-intent");

    // Action 1: Confirm payment and update order status to 'paid'
    if (action === "confirm" || body.paymentIntentId) {
      const paymentIntentId = String(body.paymentIntentId || order.stripe_session_id || "").trim();
      if (!paymentIntentId) {
        return NextResponse.json({ success: false, error: "paymentIntentId is required to confirm payment." }, { status: 400 });
      }

      // If already paid, return successful response immediately
      if (
        order.status === "paid" ||
        order.status === "bootstrap_running" ||
        order.status === "bootstrap_done" ||
        order.status === "install_running" ||
        order.status === "completed"
      ) {
        return NextResponse.json({
          success: true,
          order,
          status: order.status,
          message: "Order is already paid.",
        });
      }

      const stripe = getStripeInstance();
      const isMockIntent = paymentIntentId.startsWith("pi_mock_") && process.env.NODE_ENV !== "production";

      if (stripe && !isMockIntent) {
        try {
          const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
          if (pi.status !== "succeeded") {
            return NextResponse.json(
              { success: false, error: `Stripe payment is not completed. Status: ${pi.status}` },
              { status: 400 }
            );
          }
          if (pi.metadata?.orderId && pi.metadata.orderId !== order.id) {
            return NextResponse.json(
              { success: false, error: "PaymentIntent does not match this order." },
              { status: 400 }
            );
          }
        } catch (stripeErr: any) {
          return NextResponse.json(
            { success: false, error: `Stripe payment verification failed: ${stripeErr.message}` },
            { status: 400 }
          );
        }
      }

      const result = await markOrderPaid(order.id, paymentIntentId);
      if (result.kind === "ignored" && result.reason === "cancelled") {
        return NextResponse.json({ success: false, error: "Order is cancelled." }, { status: 400 });
      }
      if (result.kind === "ignored" && result.reason === "conflicting_session") {
        return NextResponse.json({ success: false, error: "Order is already bound to another Stripe transaction." }, { status: 409 });
      }

      const updated = await getOrder(order.id);
      return NextResponse.json({
        success: true,
        order: updated || order,
        status: "paid",
        deduped: result.kind === "deduped",
      });
    }

    // Action 2: Create PaymentIntent for Checkout
    if (order.status === "paid") {
      return NextResponse.json({
        success: true,
        alreadyPaid: true,
        order,
        status: order.status,
        message: "Order is already paid.",
      });
    }

    const pkg = await getPackage(order.package_id);
    if (!pkg) {
      return NextResponse.json({ success: false, error: "Package not found for this order." }, { status: 404 });
    }

    const cycle = order.billing_cycle;
    const amountCents =
      cycle === "monthly"
        ? pkg.pricing?.monthly_cents
        : cycle === "yearly"
          ? pkg.pricing?.yearly_cents
          : pkg.pricing?.lifetime_cents;
    const currency = (pkg.pricing?.currency || "USD").toLowerCase();

    if (typeof amountCents !== "number" || amountCents <= 0) {
      return NextResponse.json({ success: false, error: "Invalid package price." }, { status: 400 });
    }

    const stripe = getStripeInstance();
    if (!stripe) {
      return NextResponse.json(
        {
          success: false,
          error: "Stripe is not configured on the server (STRIPE_SECRET_KEY missing).",
        },
        { status: 500 }
      );
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency,
      description: `Slate Order ${order.id} - ${pkg.name} (${order.billing_cycle})`,
      receipt_email: order.contactEmail || undefined,
      metadata: {
        orderId: order.id,
        package_id: pkg.id,
        packageName: pkg.name,
        billing_cycle: order.billing_cycle,
        siteUrl: order.siteUrl,
      },
    });

    await updateOrder(order.id, {
      stripe_session_id: paymentIntent.id,
    });

    return NextResponse.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amountCents,
      currency,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
