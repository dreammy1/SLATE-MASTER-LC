"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { loadStripe } from "@stripe/stripe-js";
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from "@stripe/react-stripe-js";

const stripePromise = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
  ? loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY)
  : null;

/**
 * `useSearchParams()` forces a client-side bailout during static prerender, so
 * Next.js 15 requires the hook to sit behind a <Suspense> boundary. Without this
 * wrapper `next build` aborts on /checkout.
 */
function CheckoutContent() {
  const searchParams = useSearchParams();
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [error, setError] = useState<string>("");
  const [mockMessage, setMockMessage] = useState("");

  useEffect(() => {
    // We expect the iframe source to pass a session secret or token in the URL or via postMessage
    // Since this is embedded by the tenant, the tenant will call the API and get the clientSecret,
    // then render this page with the clientSecret as a query parameter (or we do it here).
    
    // Better flow for an iframe: The tenant sets src="/checkout?token=...&items=...&type=...&cycle=..."
    // Then this page calls the session endpoint itself.
    const token = searchParams.get("token");
    const type = searchParams.get("type") || searchParams.get("kind") || searchParams.get("order_type");
    const rawItems = searchParams.get("items"); // comma separated
    const cycle = searchParams.get("cycle") || searchParams.get("billing_cycle");
    const pluginSlug = searchParams.get("plugin_slug") || searchParams.get("pluginSlug");
    const packageSlug = searchParams.get("package_slug") || searchParams.get("packageSlug");
    const licenseId = searchParams.get("license_id") || searchParams.get("licenseId");
    const orderId = searchParams.get("order_id") || searchParams.get("orderId");

    if (!token || !type || (!rawItems && !packageSlug && !pluginSlug) || !cycle) {
      setError("Missing checkout parameters");
      return;
    }

    const items = rawItems
      ? rawItems.split(",").map((s) => s.trim()).filter(Boolean)
      : (packageSlug ? [packageSlug] : (pluginSlug ? [pluginSlug] : []));

    fetch("/api/master/checkout/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenant_token: token,
        order_type: type,
        items,
        billing_cycle: cycle,
        plugin_slug: pluginSlug || undefined,
        package_slug: packageSlug || undefined,
        license_id: licenseId || undefined,
        order_id: orderId || undefined,
        purchase_context: {
          kind: type,
          items,
          pluginSlug: pluginSlug || undefined,
          packageSlug: packageSlug || undefined,
          licenseId: licenseId || undefined,
          orderId: orderId || undefined,
        },
      }),
    })
    .then((r) => r.json())
    .then((data) => {
      if (!data.success) {
        const rawErr = data.error || "Failed to create checkout session";
        const errMsg = typeof rawErr === "object"
          ? (rawErr.message || rawErr.code || JSON.stringify(rawErr))
          : String(rawErr);
        setError(errMsg);
      } else if (data.mock) {
        const msg = typeof data.message === "object" ? JSON.stringify(data.message) : String(data.message || "");
        setMockMessage(msg);
      } else {
        setClientSecret(data.clientSecret);
      }
    })
    .catch((err) => {
      const errMsg = typeof err === "object" ? (err.message || JSON.stringify(err)) : String(err);
      setError(errMsg);
    });
  }, [searchParams]);

  if (error) {
    const errorText = typeof error === "object" ? ((error as any)?.message || JSON.stringify(error)) : String(error);
    return (
      <div className="flex h-screen items-center justify-center p-4">
        <div className="bg-red-500/10 text-red-500 p-4 rounded-lg border border-red-500/20 w-full max-w-md text-center">
          <p className="font-medium">Checkout Error</p>
          <p className="text-sm mt-1">{errorText}</p>
        </div>
      </div>
    );
  }

  if (mockMessage) {
    return (
      <div className="flex h-screen items-center justify-center p-4">
        <div className="bg-yellow-500/10 text-yellow-500 p-8 rounded-lg border border-yellow-500/20 w-full max-w-md text-center">
          <p className="font-semibold text-lg mb-2">Stripe Not Configured</p>
          <p className="text-sm">{mockMessage}</p>
          <p className="text-xs opacity-70 mt-4">In a live environment, the Stripe Elements UI would render here.</p>
        </div>
      </div>
    );
  }

  if (!clientSecret) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-500" />
      </div>
    );
  }

  return (
    <div className="w-full min-h-screen bg-slate-900 text-slate-100 p-2 sm:p-4 flex items-center justify-center">
      {stripePromise ? (
        <div id="checkout" className="w-full max-w-3xl rounded-xl overflow-hidden bg-slate-950 p-2 sm:p-6 shadow-2xl border border-slate-800">
          <EmbeddedCheckoutProvider
            stripe={stripePromise}
            options={{ clientSecret }}
          >
            <EmbeddedCheckout />
          </EmbeddedCheckoutProvider>
        </div>
      ) : (
        <div className="max-w-md mx-auto my-12 bg-emerald-500/10 text-emerald-500 p-8 rounded-lg border border-emerald-500/20 text-center">
          <p className="font-semibold text-lg mb-2">Stripe Session Ready</p>
          <p className="text-sm">Client Secret generated: {clientSecret.substring(0, 15)}...</p>
        </div>
      )}
    </div>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center">
          <Loader2 className="w-8 h-8 animate-spin text-slate-500" />
        </div>
      }
    >
      <CheckoutContent />
    </Suspense>
  );
}
