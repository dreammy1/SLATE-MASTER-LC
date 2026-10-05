import Stripe from "stripe";
import { Package, Order } from "./models";
import type { PurchaseKind } from "./checkoutContract";

const getStripe = () => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Stripe is not configured on the server.");
  return new Stripe(key);
};

export interface CheckoutSessionInput {
  order: Order;
  tenantId: number;
  orderType: "single" | "package";
  packageSlug?: string;
  pluginSlugs?: string[];
  billingCycle: "monthly" | "yearly" | "lifetime";
  amountCents: number;
  currency: string;
  lineItems: { name: string; description?: string; amount_cents: number }[];
  purchaseKind?: PurchaseKind;
  licenseId?: string;
  orderId?: string;
  returnUrl: string;
  prefill?: {
    email?: string;
    name?: string;
  };
}

export async function createCheckoutSession(input: CheckoutSessionInput) {
  const stripe = getStripe();

  const session = await stripe.checkout.sessions.create({
    ui_mode: "embedded",
    mode: "payment",
    customer_email: input.prefill?.email || undefined,
    line_items: input.lineItems.map((item) => ({
      price_data: {
        currency: input.currency.toLowerCase(),
        product_data: {
          name: item.name,
          description: item.description,
        },
        unit_amount: item.amount_cents,
      },
      quantity: 1,
    })),
    metadata: {
      is_plugin_shop: "true",
      orderId: input.order.id,
      tenantId: input.tenantId.toString(),
      orderType: input.orderType,
      purchase_kind: input.purchaseKind || (input.orderType === "package" ? "package" : "standalone_plugin"),
      license_id: input.licenseId || "",
      order_id: input.orderId || input.order.id,
      packageSlug: input.packageSlug || "",
      pluginSlugs: JSON.stringify(input.pluginSlugs || []),
      billingCycle: input.billingCycle,
    },
    // The embedded checkout flow relies on return_url, which Stripe intercepts
    return_url: `${input.returnUrl}/checkout/complete?session_id={CHECKOUT_SESSION_ID}`,
  });

  return session.client_secret;
}
