import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

describe("Pricing Page Stripe Elements Checkout Integration", () => {
  const orderForm = read("app/pricing/order-form.tsx");
  const payRoute = read("app/api/orders/[id]/pay/route.ts");
  const pricingPage = read("app/pricing/page.tsx");
  const envExample = read(".env.example");

  it("imports and initializes Stripe Elements correctly in order-form.tsx", () => {
    assert.match(orderForm, /import\s+.*loadStripe.*from\s+["']@stripe\/stripe-js["']/);
    assert.match(orderForm, /import\s+.*CardElement.*from\s+["']@stripe\/react-stripe-js["']/);
    assert.match(orderForm, /process\.env\.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY/);
    assert.match(orderForm, /<Elements\s+stripe=\{stripePromise\}>/);
  });

  it("displays Stripe Card details input field when Stripe payment method is selected", () => {
    assert.match(orderForm, /form\.payMethod\s*===\s*["']stripe["']/);
    assert.match(orderForm, /<CardElement/);
    assert.match(orderForm, /CARD_ELEMENT_OPTIONS/);
    assert.match(orderForm, /cardError/);
  });

  it("includes graceful fallback warning when publishable key is not configured", () => {
    assert.match(orderForm, /Stripe Publishable Key Not Configured/);
    assert.match(orderForm, /NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY/);
  });

  it("processes card payment and confirms payment status to 'paid'", () => {
    assert.match(orderForm, /confirmCardPayment/);
    assert.match(orderForm, /\/api\/orders\/\$\{.*\}\/pay/);
    assert.match(orderForm, /status:\s*["']paid["']/);
  });

  it("provides order pay API with create-intent and confirm actions", () => {
    assert.match(payRoute, /markOrderPaid/);
    assert.match(payRoute, /create-intent/);
    assert.match(payRoute, /confirm/);
    assert.match(payRoute, /status:\s*["']paid["']/);
    assert.match(payRoute, /paymentIntents\.retrieve/);
    assert.match(payRoute, /PaymentIntent does not match this order/);
  });

  it("handles error states and guards in order pay API", () => {
    assert.match(payRoute, /Order not found/);
    assert.match(payRoute, /Order has been cancelled/);
    assert.match(payRoute, /STRIPE_SECRET_KEY missing/);
  });

  it("updates pricing page log and messaging when order status is paid", () => {
    assert.match(pricingPage, /isPaid\s*\?\s*["']Payment confirmed! Ready to run deploy & install\.["']/);
  });

  it("documents NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY in .env.example", () => {
    assert.match(envExample, /NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=/);
  });
});
