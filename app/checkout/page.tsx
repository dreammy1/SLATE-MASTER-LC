"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";

/**
 * `useSearchParams()` forces a client-side bailout during static prerender, so
 * Next.js 15 requires the hook to sit behind a <Suspense> boundary. Without this
 * wrapper `next build` aborts on /checkout.
 */
function CheckoutContent() {
  const searchParams = useSearchParams();
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [mockMessage, setMockMessage] = useState("");

  useEffect(() => {
    // We expect the iframe source to pass a session secret or token in the URL or via postMessage
    // Since this is embedded by the tenant, the tenant will call the API and get the clientSecret,
    // then render this page with the clientSecret as a query parameter (or we do it here).
    
    // Better flow for an iframe: The tenant sets src="/checkout?token=...&items=...&type=...&cycle=..."
    // Then this page calls the session endpoint itself.
    const token = searchParams.get("token");
    const type = searchParams.get("type");
    const items = searchParams.get("items"); // comma separated
    const cycle = searchParams.get("cycle");

    if (!token || !type || !items || !cycle) {
      setError("Missing checkout parameters");
      return;
    }

    fetch("/api/master/checkout/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenant_token: token,
        order_type: type,
        items: items.split(","),
        billing_cycle: cycle
      })
    })
    .then(r => r.json())
    .then(data => {
      if (!data.success) {
        setError(data.error || "Failed to create checkout session");
      } else if (data.mock) {
        setMockMessage(data.message);
      } else {
        setClientSecret(data.clientSecret);
      }
    })
    .catch(err => setError(err.message));
  }, [searchParams]);

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center p-4">
        <div className="bg-red-500/10 text-red-500 p-4 rounded-lg border border-red-500/20 w-full max-w-md text-center">
          <p className="font-medium">Checkout Error</p>
          <p className="text-sm mt-1">{error}</p>
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

  // If we had the real Stripe elements loaded:
  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto">
      {/* 
        Here we would render <EmbeddedCheckoutProvider> and <EmbeddedCheckout>
        from @stripe/react-stripe-js.
        Since we only have the backend API for now and Stripe is missing a key,
        we just show a placeholder that it's ready.
      */}
      <div className="bg-emerald-500/10 text-emerald-500 p-8 rounded-lg border border-emerald-500/20 text-center">
        <p className="font-semibold text-lg mb-2">Stripe Session Ready</p>
        <p className="text-sm">Client Secret generated: {clientSecret.substring(0, 15)}...</p>
      </div>
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
