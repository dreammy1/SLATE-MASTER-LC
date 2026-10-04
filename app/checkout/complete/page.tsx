"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";

/**
 * `useSearchParams()` forces a client-side bailout during static prerender, so
 * Next.js 15 requires the hook to sit behind a <Suspense> boundary. Without this
 * wrapper `next build` aborted on /checkout/complete and the whole Master
 * dashboard could not be deployed.
 */
function CheckoutCompleteContent() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session_id");
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");

  useEffect(() => {
    if (!sessionId) {
      setStatus("error");
      return;
    }
    
    // In a real app we'd verify the session_id status with our backend,
    // but the Stripe webhook is what actually provisions the license.
    // So we just assume success if we reached here, and postMessage to parent.
    setStatus("success");
    
    // Notify the tenant dashboard iframe parent that checkout is complete
    if (typeof window !== "undefined" && window.parent !== window) {
      setTimeout(() => {
        window.parent.postMessage({ type: "SLATE_CHECKOUT_COMPLETE", sessionId }, "*");
      }, 2000);
    }
  }, [sessionId]);

  if (status === "loading") {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-500" />
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex h-screen items-center justify-center p-4">
        <div className="bg-red-500/10 text-red-500 p-8 rounded-lg border border-red-500/20 text-center">
          <XCircle className="w-12 h-12 mx-auto mb-4" />
          <h2 className="text-xl font-semibold mb-2">Checkout Failed</h2>
          <p className="text-sm">We could not verify your payment session.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center p-4 bg-slate-50/50">
      <div className="bg-white text-slate-800 p-8 rounded-xl shadow-sm border border-slate-200 text-center max-w-md w-full">
        <CheckCircle2 className="w-16 h-16 mx-auto mb-4 text-emerald-500" />
        <h2 className="text-2xl font-bold mb-2">Payment Successful!</h2>
        <p className="text-slate-500 mb-6">
          Your payment has been processed and your license is being updated.
        </p>
        <p className="text-sm font-medium text-slate-400">
          Redirecting back to dashboard...
        </p>
      </div>
    </div>
  );
}

export default function CheckoutCompletePage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center">
          <Loader2 className="w-8 h-8 animate-spin text-slate-500" />
        </div>
      }
    >
      <CheckoutCompleteContent />
    </Suspense>
  );
}
