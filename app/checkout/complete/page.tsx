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
  const cancelled = searchParams.get("cancelled") === "1" || searchParams.get("canceled") === "1";
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");

  useEffect(() => {
    const postToParent = (message: Record<string, unknown>) => {
      if (typeof window === "undefined" || window.parent === window) return;
      let parentOrigin = "";
      try { parentOrigin = document.referrer ? new URL(document.referrer).origin : ""; } catch { parentOrigin = ""; }
      if (parentOrigin) window.parent.postMessage({ version: 1, ...message }, parentOrigin);
    };
    if (cancelled) {
      setStatus("error");
      postToParent({ type: "slate.checkout.cancelled" });
      return;
    }
    if (!sessionId) {
      setStatus("error");
      postToParent({ type: "slate.checkout.failed", code: "missing_session" });
      return;
    }
    
    // In a real app we'd verify the session_id status with our backend,
    // but the Stripe webhook is what actually provisions the license.
    // So we just assume success if we reached here, and postMessage to parent.
    setStatus("success");
    
    setTimeout(() => postToParent({ type: "slate.checkout.completed", sessionId }), 2000);
  }, [sessionId, cancelled]);

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
          <h2 className="text-xl font-semibold mb-2">{cancelled ? "Checkout Cancelled" : "Checkout Failed"}</h2>
          <p className="text-sm">{cancelled ? "No payment was taken." : "We could not verify your payment session."}</p>
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
