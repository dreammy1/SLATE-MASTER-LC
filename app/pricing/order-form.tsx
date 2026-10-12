"use client";
import React, { useMemo, useState, useEffect } from "react";
import { fetchJson } from "@/lib/safeJson";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, CardElement, useStripe, useElements } from "@stripe/react-stripe-js";

const stripePublishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || "";
const stripePromise = stripePublishableKey ? loadStripe(stripePublishableKey) : null;

const CARD_ELEMENT_OPTIONS = {
  style: {
    base: {
      color: "#f8fafc",
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: "13px",
      "::placeholder": {
        color: "#64748b",
      },
    },
    invalid: {
      color: "#f43f5e",
      iconColor: "#f43f5e",
    },
  },
  hidePostalCode: false,
};

function splitDomainInput(raw: string): { domain: string; subPath: string } {
  let s = String(raw || "").trim().replace(/^https?:\/\//i, "").trim().split(/[?#]/)[0].trim().replace(/\/+$/, "");
  if (!s) return { domain: "", subPath: "" };
  const i = s.indexOf("/");
  if (i < 0) return { domain: s.toLowerCase(), subPath: "" };
  return { domain: s.slice(0, i).toLowerCase(), subPath: s.slice(i + 1).replace(/^\/+|\/+$/g, "") };
}

function derivedTarget(raw: string) {
  const { domain, subPath } = splitDomainInput(raw);
  if (!domain) return { siteUrl: "", uploadPath: "/public_html", basePath: "/" };
  return {
    siteUrl: subPath ? `https://${domain}/${subPath}` : `https://${domain}`,
    uploadPath: subPath ? `/public_html/${subPath}` : "/public_html",
    basePath: subPath ? `/${subPath}` : "/",
  };
}

function OrderFormInner({ pkg, cycle, onOrder }: { pkg: any; cycle: string; onOrder: (o: any) => void }) {
  const [form, setForm] = useState({
    siteDomain: "", hostingUsername: "", hostingServerUrl: "",
    contactName: "", contactPhone: "", contactEmail: "", payMethod: "stripe",
  });
  const [busy, setBusy] = useState(false);
  const [cardError, setCardError] = useState("");
  const target = useMemo(() => derivedTarget(form.siteDomain), [form.siteDomain]);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const stripe = useStripe();
  const elements = useElements();

  const priceCents = cycle === "monthly" ? pkg?.pricing?.monthly_cents : cycle === "yearly" ? pkg?.pricing?.yearly_cents : pkg?.pricing?.lifetime_cents;
  const priceLabel = typeof priceCents === "number" ? `${(priceCents / 100).toFixed(2)} ${pkg?.pricing?.currency || "USD"}` : "";

  const inputCls = "bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white text-xs w-full";
  const labelCls = "block text-[11px] text-slate-400 mb-1";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setCardError("");

    try {
      if (form.payMethod === "stripe") {
        if (!stripePublishableKey || !stripe || !elements) {
          alert("Stripe card payment is not configured (NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY missing). Please set the key or choose Bank transfer / Cash on delivery.");
          setBusy(false);
          return;
        }
        const cardElement = elements.getElement(CardElement);
        if (!cardElement) {
          alert("Card input field could not be found. Please refresh and try again.");
          setBusy(false);
          return;
        }
      }

      // 1. Create order
      const { data: d } = await fetchJson("/api/orders", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ package_id: pkg.id, billing_cycle: cycle, ...form }),
      });
      if (!d?.success || !d.order) {
        alert(d?.error || "Order placement failed.");
        setBusy(false);
        return;
      }

      let currentOrder = d.order;

      // 2. If Stripe payment method selected, process card payment
      if (form.payMethod === "stripe") {
        const cardElement = elements!.getElement(CardElement)!;

        // 2a. Request payment intent creation on the backend
        const { data: intentData } = await fetchJson(`/api/orders/${currentOrder.id}/pay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "create-intent" }),
        });

        if (!intentData?.success || !intentData?.clientSecret) {
          const msg = intentData?.error || "Could not initialize Stripe payment intent.";
          setCardError(msg);
          alert(msg);
          setBusy(false);
          return;
        }

        // 2b. Confirm card payment with Stripe
        const paymentResult = await stripe!.confirmCardPayment(intentData.clientSecret, {
          payment_method: {
            card: cardElement,
            billing_details: {
              name: form.contactName,
              email: form.contactEmail,
              phone: form.contactPhone || undefined,
            },
          },
        });

        if (paymentResult.error) {
          const msg = paymentResult.error.message || "Card payment failed.";
          setCardError(msg);
          alert(`Payment failed: ${msg}`);
          setBusy(false);
          return;
        }

        if (paymentResult.paymentIntent?.status !== "succeeded") {
          const msg = `Payment incomplete (Status: ${paymentResult.paymentIntent?.status || "unknown"}).`;
          setCardError(msg);
          alert(msg);
          setBusy(false);
          return;
        }

        // 2c. Confirm payment callback with backend to mark order 'paid' automatically
        const { data: confirmData } = await fetchJson(`/api/orders/${currentOrder.id}/pay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "confirm",
            paymentIntentId: paymentResult.paymentIntent.id,
          }),
        });

        if (confirmData?.success && confirmData?.order) {
          currentOrder = confirmData.order;
        } else {
          currentOrder = { ...currentOrder, status: "paid" };
        }
        if (confirmData?.licenseKey) {
          currentOrder.licenseKey = confirmData.licenseKey;
        }
      }

      // The server check rides along as a banner, never as a purchase refusal.
      if (d?.serverVerified === "needs_help") {
        alert(
          `Order ${currentOrder?.id || ""} saved and sent for review. One thing needs you: the server login did not pass its check (${d?.serverCheckMessage || "could not be verified"}). Your payment is safe — fix the login here or support will contact you.`
        );
      }
      onOrder({ ...currentOrder, pkg, serverVerified: d?.serverVerified, serverCheckMessage: d?.serverCheckMessage });
    } catch (err: any) {
      alert(err?.message || "Could not place the order. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const isWpPlugin = pkg?.productType === "wordpress_plugin" || Boolean(pkg?.assetPath);
  const isDigital = pkg?.productType === "digital_product";

  return (
    <form onSubmit={submit} className="max-w-2xl mx-auto mt-6 rounded-xl p-5 border border-[#1e293b] bg-[#111625] grid grid-cols-1 md:grid-cols-2 gap-3">
      <div className="md:col-span-2 text-white font-bold">Checkout → {pkg.name} / {cycle}</div>
      <div className="md:col-span-2 text-[11px] text-slate-400">
        {isWpPlugin
          ? "Instant automated delivery. Get your license key, invoice, and ready-to-install WordPress plugin ZIP immediately after payment."
          : isDigital
          ? "Instant automated digital product delivery. Download your asset and license certificate upon payment."
          : "No API token needed. Upload one file, press Test Connection, then deploy — fully guided below."}
      </div>
      <div className="md:col-span-2">
        <label className={labelCls}>
          {isWpPlugin
            ? "1. WordPress Site URL / Domain * (e.g. yoursite.com)"
            : "1. Site domain * (client.com or client.com/crm)"}
        </label>
        <input value={form.siteDomain} onChange={(e) => set("siteDomain", e.target.value)} required
          placeholder={isWpPlugin ? "yoursite.com" : "client.com  or  client.com/crm"} className={inputCls} />
        {form.siteDomain.trim() !== "" && target.siteUrl && !isWpPlugin && !isDigital && (
          <div className="mt-1 rounded border border-[#00f0ff]/30 bg-[#00f0ff]/5 px-3 py-2 text-[11px] text-slate-300">
            Will install at <span className="text-[#00f0ff] font-mono">{target.siteUrl}</span>
            {" "}· upload to <span className="font-mono">📂 {target.uploadPath}</span>
          </div>
        )}
      </div>
      {!isWpPlugin && !isDigital && (
        <>
          <div>
            <label className={labelCls}>2. Hosting username * (cPanel username)</label>
            <input value={form.hostingUsername} onChange={(e) => set("hostingUsername", e.target.value)} required
              placeholder="e.g. clientuser" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>3. Hosting server URL * (cPanel / n0c panel URL)</label>
            <input value={form.hostingServerUrl} onChange={(e) => set("hostingServerUrl", e.target.value)} required
              placeholder="https://cpanel.client.com:2083" className={inputCls} />
          </div>
        </>
      )}
      <div>
        <label className={labelCls}>4. Full name *</label>
        <input value={form.contactName} onChange={(e) => set("contactName", e.target.value)} required
          placeholder="Your name" className={inputCls} />
      </div>
      <div>
        <label className={labelCls}>5. Phone</label>
        <input value={form.contactPhone} onChange={(e) => set("contactPhone", e.target.value)}
          placeholder="Phone number" className={inputCls} />
      </div>
      <div className="md:col-span-2">
        <label className={labelCls}>
          {isWpPlugin || isDigital
            ? "6. Email * (license key & invoice will be sent here)"
            : "6. Email * (this becomes your admin password)"}
        </label>
        <input type="email" value={form.contactEmail} onChange={(e) => set("contactEmail", e.target.value)} required
          placeholder="you@example.com" className={inputCls} />
      </div>
      <div className="md:col-span-2">
        <label className={labelCls}>7. Payment method</label>
        <select value={form.payMethod} onChange={(e) => set("payMethod", e.target.value)} className={inputCls}>
          <option value="stripe">Stripe (Credit / Debit Card)</option>
          <option value="bank">Bank transfer (manual approve)</option>
          <option value="cod">Cash on delivery (manual approve)</option>
        </select>
      </div>

      {form.payMethod === "stripe" && (
        <>
          {stripePublishableKey ? (
            <div className="md:col-span-2 space-y-2 rounded-lg border border-[#00f0ff]/30 bg-[#0a0d14]/80 p-3.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-bold text-white flex items-center gap-1.5">
                  <span>💳 Card Details (Stripe)</span>
                </label>
                <span className="text-[10px] text-emerald-400 font-mono flex items-center gap-1">
                  <span>🔒 256-bit SSL encrypted</span>
                </span>
              </div>
              <div className="rounded border border-[#1e293b] bg-[#0a0d14] p-3 focus-within:border-[#00f0ff] transition-colors">
                <CardElement
                  options={CARD_ELEMENT_OPTIONS}
                  onChange={(e) => {
                    if (e.error) {
                      setCardError(e.error.message);
                    } else {
                      setCardError("");
                    }
                  }}
                />
              </div>
              {cardError && (
                <div className="text-[11px] text-rose-400 font-medium">
                  {cardError}
                </div>
              )}
              <div className="text-[10px] text-slate-400 flex items-center justify-between pt-1">
                <span>Card details are processed securely by Stripe.</span>
                {priceLabel && <span>Total: <b className="text-white">{priceLabel}</b></span>}
              </div>
            </div>
          ) : (
            <div className="md:col-span-2 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
              <div className="font-bold text-amber-300 mb-1">⚠️ Stripe Publishable Key Not Configured</div>
              <div>
                Stripe card payments require <code className="font-mono bg-[#0a0d14] px-1 py-0.5 rounded text-white">NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY</code> in environment variables.
              </div>
              <div className="mt-1 text-slate-300">
                Please configure your Stripe publishable key to accept live card payments, or select <b>Bank transfer</b> or <b>Cash on delivery</b> to proceed with manual approval.
              </div>
            </div>
          )}
        </>
      )}

      <div className="md:col-span-2 flex justify-end">
        <button
          type="submit"
          disabled={busy}
          className="px-5 py-2 rounded bg-[#00f0ff] text-black font-bold disabled:opacity-50 hover:bg-[#00d0df] transition-colors"
        >
          {busy
            ? "Processing…"
            : form.payMethod === "stripe" && priceLabel
              ? `Pay with Card (${priceLabel}) →`
              : "Place order & continue →"}
        </button>
      </div>
    </form>
  );
}

export function OrderForm({ pkg, cycle, onOrder }: { pkg: any; cycle: string; onOrder: (o: any) => void }) {
  return (
    <Elements stripe={stripePromise}>
      <OrderFormInner pkg={pkg} cycle={cycle} onOrder={onOrder} />
    </Elements>
  );
}

type Guide = { title: string; reason: string; steps: string[]; retryable?: boolean; retryLabel?: string; helpUrl?: string };
type Failure = { message: string; failedStage: string; percent: number; guide?: Guide };
type Success = { activateUrl: string; licenseKey: string; maskedKey: string; expiresAt: string | null; siteUrl: string; warnings: string[] };
type InstallerSuccess = {
  loginUrl: string; adminUser: string; adminPassHint: string; siteUrl: string;
  licenseKey: string; plugins: string[]; warnings: string[]; liveness?: string;
};

/** Parse NDJSON stream into stage/progress/log/failure/success callbacks. */
async function runNdjsonStream(url: string, payload: any, cbs: {
  onEvent: (ev: any) => void; onFailure: (f: Failure) => void;
  onBootstrapSuccess: (s: Success) => void; onInstallerSuccess: (s: InstallerSuccess) => void;
  progress: number; stage: string;
}): Promise<void> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!res.ok || !res.body) {
    const e = await res.text().then((t) => { try { return JSON.parse(t) || {}; } catch { return {}; } }).catch(() => ({} as any));
    const reason = e.error || `Server responded ${res.status}`;
    cbs.onFailure({ message: reason, failedStage: "REQUEST", percent: cbs.progress, guide: e.guide || { title: "We could not start the setup", reason, steps: ["Confirm the payment is approved (order status should be paid).", ...RETRY_STEPS], retryable: true, retryLabel: "Retry automation" } });
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let lastEvent = Date.now();
  let sawDone = false;
  const watchdog = setInterval(() => {
    const idle = Date.now() - lastEvent;
    if (idle > 45_000 && !sawDone) {
      cbs.onFailure({
        message: `No update from the server for ${Math.round(idle / 1000)}s. The connection was dropped while running step "${cbs.stage || "setup"}".`,
        failedStage: cbs.stage || "CONNECTION", percent: cbs.progress,
        guide: { title: "The setup connection was interrupted", reason: "Your server may still be working, or the request was cut off by a proxy/timeout.", steps: ["Press Retry automation — the setup resumes from the step it stopped at and never duplicates work.", "Open your order status page to see the last recorded step before retrying.", "If it keeps dropping at the same step, send support the step name and your order ID."], retryable: true, retryLabel: "Retry automation" },
      });
    }
  }, 5_000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lastEvent = Date.now();
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; }
        cbs.onEvent(ev);
        if (ev.error) cbs.onFailure({ message: ev.error, failedStage: ev.failedStage || "UNKNOWN", percent: ev.percent ?? 0, guide: ev.guide });
        if (ev.done && ev.licenseKey && ev.loginUrl) {
          sawDone = true;
          cbs.onInstallerSuccess({ loginUrl: ev.loginUrl, adminUser: ev.adminUser || "admin", adminPassHint: ev.adminPassHint || "", siteUrl: ev.siteUrl, licenseKey: ev.licenseKey, plugins: ev.plugins || [], warnings: ev.warnings || [], liveness: ev.liveness });
        } else if (ev.done) {
          sawDone = true;
          cbs.onBootstrapSuccess({ activateUrl: ev.activateUrl, licenseKey: ev.licenseKey, maskedKey: ev.maskedKey, expiresAt: ev.expiresAt ?? null, siteUrl: ev.siteUrl, warnings: ev.warnings || [] });
        }
      }
    }
  } finally { clearInterval(watchdog); }
}

const RETRY_STEPS = [
  "Nothing was lost and you were not charged twice.",
  "Press Retry automation - most temporary problems fix themselves on the second try.",
  "If it fails again, copy the red error text and send it to support with your order ID.",
];

export function WordPressDeliveryWidget({ order, pkg }: { order: any; pkg?: any }) {
  const [copied, setCopied] = useState(false);
  const [loadingKey, setLoadingKey] = useState(false);
  const [key, setKey] = useState(order.licenseKey || "");

  useEffect(() => {
    if (!key && order.id) {
      setLoadingKey(true);
      fetch(`/api/orders/${order.id}`)
        .then((r) => r.json())
        .then((d) => {
          if (d?.order?.licenseKey) setKey(d.order.licenseKey);
        })
        .catch(() => {})
        .finally(() => setLoadingKey(false));
    }
  }, [order.id, key]);

  const copyKey = async () => {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* ignore */
    }
  };

  const downloadKeyTxt = () => {
    const content = [
      "=======================================================",
      "  SLATE DevOps OS — Official License Key Certificate",
      "=======================================================",
      `Product:       ${pkg?.name || order.packageName || "WordPress Plugin"}`,
      `Order ID:      ${order.id}`,
      `License Key:   ${key || "Issued upon confirmation"}`,
      `Site Domain:   ${order.siteUrl || "Active"}`,
      `Date:          ${new Date().toISOString()}`,
      "=======================================================",
      "",
      "WordPress Installation:",
      "1. Download and install plugin ZIP in WP Admin.",
      "2. Go to Settings > [Plugin] License and enter key.",
      "=======================================================",
    ].join("\r\n");

    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `license-${order.id}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const isPaid = ["paid", "completed", "bootstrap_done", "install_running"].includes(order.status);

  return (
    <div className="max-w-2xl mx-auto mt-6 rounded-xl p-5 border border-[#00f0ff] bg-[#00f0ff]/5 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-[#00f0ff] animate-pulse"></span>
          <span className="font-extrabold text-white text-base">
            {isPaid ? "Payment Confirmed — WordPress Plugin Ready!" : "WordPress Plugin Order Created"}
          </span>
        </div>
        <span className="text-xs px-2.5 py-1 rounded bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/40">
          {isPaid ? "READY TO INSTALL" : String(order.status).toUpperCase()}
        </span>
      </div>

      <div className="rounded-lg border border-[#1e293b] bg-[#0a0d14] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-400">Order #{order.id}</span>
          <span className="text-xs text-[#00f0ff] font-bold">{pkg?.name || "WordPress Plugin"}</span>
        </div>

        <div className="border-t border-[#1e293b] pt-3">
          <div className="text-[11px] text-slate-400 uppercase tracking-wide font-semibold mb-1">
            Your License Key
          </div>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="font-mono text-base font-bold text-white tracking-wider bg-[#111625] px-3 py-1.5 rounded border border-[#1e293b]">
              {key ? key : loadingKey ? "Loading key..." : order.licenseKeyLast4 ? `****${order.licenseKeyLast4}` : "Issued upon payment"}
            </div>
            {key && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={copyKey}
                  className="px-3 py-1.5 rounded border border-[#00f0ff] bg-[#00f0ff]/10 hover:bg-[#00f0ff] hover:text-black text-[#00f0ff] font-bold text-xs transition"
                >
                  {copied ? "Copied!" : "Copy Key"}
                </button>
                <button
                  type="button"
                  onClick={downloadKeyTxt}
                  className="px-3 py-1.5 rounded border border-slate-600 bg-slate-800 hover:border-slate-400 text-slate-200 font-bold text-xs transition"
                >
                  Download .txt
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {isPaid && (
        <div className="flex flex-wrap gap-3 items-center">
          <a
            href={`/api/orders/${order.id}/download`}
            className="px-5 py-2.5 rounded bg-[#00f0ff] text-black font-bold text-xs flex items-center gap-2 shadow-lg shadow-[#00f0ff]/20 hover:opacity-90 transition"
          >
            <span>📥 Download Plugin ZIP (Ready to Install)</span>
          </a>
          <a
            href={`/api/orders/${order.id}/invoice`}
            target="_blank"
            rel="noreferrer"
            className="px-4 py-2.5 rounded border border-slate-600 bg-slate-800/80 hover:bg-slate-700 text-white font-bold text-xs transition"
          >
            <span>📄 View / Print Invoice</span>
          </a>
          <a
            href={`/orders/${order.id}`}
            className="px-4 py-2.5 rounded border border-[#1e293b] text-slate-400 hover:text-white text-xs transition"
          >
            Full Order Details →
          </a>
        </div>
      )}

      <div className="rounded-lg border border-[#1e293b] bg-[#0a0d14]/70 p-4 space-y-2 text-xs">
        <div className="font-bold text-white flex items-center gap-1.5 mb-1">
          <span>📖 3-Step WordPress Setup Guide:</span>
        </div>
        <div className="space-y-1.5 text-slate-300">
          <div className="flex items-start gap-2">
            <span className="rounded-full bg-[#00f0ff]/20 text-[#00f0ff] w-5 h-5 flex items-center justify-center font-bold text-[10px] shrink-0">1</span>
            <span>Download the ready-to-install distribution ZIP using the button above.</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="rounded-full bg-[#00f0ff]/20 text-[#00f0ff] w-5 h-5 flex items-center justify-center font-bold text-[10px] shrink-0">2</span>
            <span>In your WordPress Admin, go to <b>Plugins &gt; Add New &gt; Upload Plugin</b>, select the file, and click <b>Activate Plugin</b>.</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="rounded-full bg-[#00f0ff]/20 text-[#00f0ff] w-5 h-5 flex items-center justify-center font-bold text-[10px] shrink-0">3</span>
            <span>Navigate to the plugin&apos;s <b>License</b> settings page in WordPress Admin, paste your License Key, and click <b>Activate License</b>.</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function BootstrapRunner({ order, progress, setProgress, log, setLog, pkg }: any) {
  const isWp =
    order?.productType === "wordpress_plugin" ||
    order?.package?.productType === "wordpress_plugin" ||
    order?.pkg?.productType === "wordpress_plugin" ||
    pkg?.productType === "wordpress_plugin" ||
    Boolean(order?.assetPath || order?.package?.assetPath || pkg?.assetPath);

  if (isWp) {
    return <WordPressDeliveryWidget order={order} pkg={pkg || order.pkg || order.package} />;
  }
  return <InstallerWidget order={order} progress={progress} setProgress={setProgress} log={log} setLog={setLog} />;
}

export function InstallerWidget({ order, progress, setProgress, log, setLog }: any) {
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<string>("");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [success, setSuccess] = useState<Success | null>(null);
  const [installed, setInstalled] = useState<InstallerSuccess | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [connState, setConnState] = useState<"idle" | "checking" | "ready" | "failed">("idle");
  const [connMsg, setConnMsg] = useState("");
  const [db, setDb] = useState({ dbHost: "localhost", dbName: "", dbUser: "", dbPass: "" });
  const [showManualDb, setShowManualDb] = useState(false);
  const needsHelp = order?.serverVerified === "needs_help";
  const uploadPath = order?.fileManagerPath || "/public_html";
  const manualMode = !order?.cpanelApiTokenSet && order?.serverVerified !== "verified";

  const testConnection = async () => {
    setConnState("checking"); setConnMsg("");
    setLog((l: string[]) => [...l, "Testing connection to your uploaded auth.php…"]);
    try {
      const { data: d } = await fetchJson(`/api/orders/${order.id}/test-connection`, { method: "POST" });
      if (d?.success && d?.ready) {
        setConnState("ready"); setConnMsg(d.message || "Environment Ready ✅");
        setLog((l: string[]) => [...l, "✅ Environment Ready — deploy unlocked."]);
      } else {
        setConnState("failed"); setConnMsg(d?.error || "Connection failed.");
        setLog((l: string[]) => [...l, `❌ Test failed: ${d?.error || "unknown"}`]);
      }
    } catch (err: any) {
      setConnState("failed"); setConnMsg(err?.message || "Could not reach the test endpoint.");
    }
  };

  const run = async () => {
    setRunning(true); setFailure(null); setSuccess(null); setInstalled(null); setWarnings([]);
    const payload: any = {};
    // Manual mode: send the DB credentials the customer typed on the card.
    if (manualMode && db.dbName && db.dbUser && db.dbPass) {
      payload.dbHost = db.dbHost || "localhost";
      payload.dbName = db.dbName; payload.dbUser = db.dbUser; payload.dbPass = db.dbPass;
    }
    setLog((l: string[]) => [...l, "Starting setup automation..."]);
    await runNdjsonStream(`/api/orders/${order.id}/deploy`, payload, {
      progress, stage,
      onEvent: (ev: any) => {
        if (ev.heartbeat) return;
        if (ev.stage) setStage(ev.stage);
        if (typeof ev.percent === "number") setProgress(ev.percent);
        if (ev.message) setLog((l: string[]) => [...l, `[${ev.percent ?? 0}%] ${ev.message}`]);
        if (Array.isArray(ev.warnings) && ev.warnings.length) setWarnings(ev.warnings);
      },
      onFailure: (f) => setFailure(f),
      onBootstrapSuccess: (s) => {
        setSuccess(s);
        setLog((l: string[]) => [...l, "Setup complete. Your server is ready."]);
      },
      onInstallerSuccess: (s) => {
        setInstalled(s);
        setWarnings(s.warnings || []);
        if (s.licenseKey) setSuccess({ activateUrl: `${s.siteUrl}/activate.php`, licenseKey: s.licenseKey, maskedKey: "", expiresAt: null, siteUrl: s.siteUrl, warnings: s.warnings || [] });
        setLog((l: string[]) => [...l, "Install complete. Your Slate site is live."]);
      },
    }).catch((err: any) => {
      const reason = err?.message || "Network error";
      setFailure({ message: reason, failedStage: "NETWORK", percent: progress, guide: { title: "Connection problem", reason, steps: RETRY_STEPS, retryable: true, retryLabel: "Retry automation" } });
    }).finally(() => setRunning(false));
  };

  const copyKey = async (key?: string) => {
    const k = key || success?.licenseKey || installed?.licenseKey || "";
    if (!k) return;
    try { await navigator.clipboard.writeText(k); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { /* ignore */ }
  };

  const helpLine = needsHelp
    ? `Heads up: the server login did not verify (${order?.serverCheckMessage || "check failed"}). You can still run the setup — it will stop at the login step and tell you exactly what to fix, or open your order page to correct the details first.`
    : "";

  return (
    <div className="max-w-2xl mx-auto mt-6 rounded-xl p-5 border border-[#1e293b] bg-[#111625] space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-white font-bold">Bootstrap Installer — Order {order.id}</div>
        <span className="text-[11px] font-mono px-2 py-1 rounded border border-[#1e293b] text-slate-300">{order.status}</span>
      </div>

      {/* Step 0 — downloads */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <a href={`/api/orders/${order.id}/invoice`} target="_blank" rel="noreferrer"
          className="px-4 py-2 rounded border border-[#1e293b] text-slate-200 text-xs text-center hover:border-[#00f0ff]">
          🧾 Download Invoice (PDF/Print)
        </a>
        <a href={`/api/orders/${order.id}/download-auth`}
          className="px-4 py-2 rounded border border-[#00f0ff] text-[#00f0ff] text-xs text-center font-bold">
          ⬇ Download Configured auth.php
        </a>
      </div>

      {/* Smart upload guide */}
      <div className="rounded-lg border border-[#00f0ff]/30 bg-[#00f0ff]/5 p-3 text-[11px] text-slate-200">
        <div className="font-bold text-white mb-1">📂 Upload guide — upload your auth.php to exactly this path:</div>
        <code className="font-mono text-[#00f0ff] break-all">{uploadPath}/auth.php</code>
        <div className="mt-1 text-slate-300">cPanel / n0c → File Manager → open <span className="font-mono">{uploadPath}</span> → upload → permissions 0644 (folder 0755). Then press “1. Test Connection”.</div>
        <div className="mt-1 text-slate-400">Site URL: <span className="font-mono">{order.siteUrl}</span></div>
      </div>

      {/* Step 1 — Test Connection */}
      <div className={`rounded-lg border p-3 ${connState === "ready" ? "border-emerald-500/50 bg-emerald-500/10" : "border-[#1e293b] bg-[#0a0d14]/60"}`}>
        <div className="flex items-center gap-2">
          <button onClick={testConnection} disabled={connState === "checking"}
            className="px-4 py-2 rounded border border-[#00f0ff] text-[#00f0ff] font-bold text-xs disabled:opacity-50">
            {connState === "checking" ? "Testing…" : "1. Test Connection"}
          </button>
          {connState === "ready" && <span className="text-emerald-300 text-xs font-bold">Environment Ready ✅</span>}
          {connState === "failed" && <span className="text-rose-300 text-xs font-bold">Not reachable ❌</span>}
        </div>
        {connMsg && <div className="mt-2 text-[11px] text-slate-200 break-words">{connMsg}</div>}
      </div>

      {/* Optional manual DB settings toggle */}
      {!installed && (
        <div className="rounded-lg border border-[#1e293b] bg-[#0a0d14]/40 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-white text-xs font-semibold">
              ✨ Database Auto-Provisioning: <span className="text-emerald-400 font-normal">Active (Created automatically via installer)</span>
            </span>
            <button
              type="button"
              onClick={() => setShowManualDb(!showManualDb)}
              className="text-[11px] text-[#00f0ff] hover:underline"
            >
              {showManualDb ? "Hide custom DB fields ▲" : "Provide custom DB credentials ▼"}
            </button>
          </div>
          {showManualDb && (
            <div className="pt-2 border-t border-[#1e293b]/50 space-y-2">
              <div className="text-[11px] text-slate-300">
                Only needed if your host blocks auto-provisioning. Leave empty to let auth.php create it automatically.
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input value={db.dbHost} onChange={(e) => setDb({ ...db, dbHost: e.target.value })} placeholder="DB host (localhost)" className="bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white text-xs" />
                <input value={db.dbName} onChange={(e) => setDb({ ...db, dbName: e.target.value })} placeholder="DB name" className="bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white text-xs" />
                <input value={db.dbUser} onChange={(e) => setDb({ ...db, dbUser: e.target.value })} placeholder="DB user" className="bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white text-xs" />
                <input type="password" value={db.dbPass} onChange={(e) => setDb({ ...db, dbPass: e.target.value })} placeholder="DB password" className="bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white text-xs" />
              </div>
            </div>
          )}
        </div>
      )}

      {needsHelp && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
          <div className="text-amber-300 font-bold text-xs mb-1">Server login needs attention — your order is safe</div>
          <div className="text-[11px] text-amber-200">{helpLine}</div>
          <a href={`/orders/${order.id}`} className="inline-block mt-2 text-[11px] text-[#00f0ff] underline">
            Fix the server details on the order page
          </a>
        </div>
      )}

      <div>
        <div className="h-3 bg-[#0a0d14] rounded-full overflow-hidden border border-[#1e293b]">
          <div className="h-full bg-gradient-to-r from-[#00f0ff] to-[#10b981] transition-all" style={{ width: `${progress}%` }} />
        </div>
        <div className="flex justify-between text-[11px] font-mono text-slate-400 mt-1">
          <span>{stage || "IDLE"}</span><span>{progress}%</span>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
          <div className="text-amber-300 font-bold text-xs mb-1">Please note</div>
          {warnings.map((w, i) => <div key={i} className="text-[11px] text-amber-200">- {w}</div>)}
        </div>
      )}

      {failure && (
        <div className="rounded-lg border border-rose-500/50 bg-rose-500/10 p-4 space-y-3">
          <div className="text-rose-300 font-bold">{failure.guide?.title || "Setup could not continue"}</div>
          <div className="text-[11px] text-rose-200 font-mono break-words">
            <b>What happened:</b> {failure.guide?.reason || failure.message}
          </div>
          <div className="text-[11px] text-rose-200 font-mono">
            <b>Step:</b> {failure.failedStage} at {failure.percent}%
          </div>
          <div className="rounded bg-[#0a0d14]/70 border border-[#1e293b] p-3">
            <div className="text-white text-xs font-bold mb-2">Fix it yourself in a few clicks:</div>
            <ol className="list-decimal list-inside space-y-1">
              {(failure.guide?.steps || RETRY_STEPS).map((s, i) => (
                <li key={i} className="text-[11px] text-slate-200">{s}</li>
              ))}
            </ol>
            {failure.guide?.helpUrl && (
              <a href={failure.guide.helpUrl} target="_blank" rel="noreferrer" className="inline-block mt-2 text-[11px] text-[#00f0ff] underline">
                Open the host documentation
              </a>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={run} disabled={running}
              className="px-4 py-2 rounded border border-[#00f0ff] text-[#00f0ff] font-bold text-xs disabled:opacity-50">
              {running ? "Working..." : (failure.guide?.retryLabel || "Retry automation")}
            </button>
            <button onClick={() => alert("Send this to support:\nOrder: " + order.id + "\nStep: " + failure.failedStage + "\nError: " + failure.message)}
              className="px-4 py-2 rounded border border-[#1e293b] text-slate-300 text-xs">
              Copy details for support
            </button>
          </div>
            <a href={`/orders/${order.id}`}
              className="px-4 py-2 rounded border border-[#1e293b] text-slate-300 text-xs">
              View order status
            </a>
        </div>
      )}

      {installed ? (
        <div className="rounded-lg border border-emerald-500/50 bg-emerald-500/10 p-4 space-y-3">
          <div className="text-emerald-300 font-bold text-base">🎉 Install complete — your Slate site is live!</div>
          <div className="text-[11px] text-emerald-200 grid grid-cols-1 gap-1">
            <div>Dashboard: <a href={installed.loginUrl} target="_blank" rel="noreferrer" className="font-mono underline break-all">{installed.loginUrl}</a></div>
            <div>Username: <code className="font-mono bg-[#0a0d14]/70 px-2 py-0.5 rounded border border-[#1e293b]">{installed.adminUser}</code>
              {" "}· Password: <span className="font-mono">{installed.adminPassHint || "(your billing email)"}</span></div>
            {installed.liveness && <div className="text-slate-300">{installed.liveness}</div>}
          </div>
          <div>
            <div className="text-[11px] text-emerald-200 mb-1">Your License Key <span className="text-slate-400">(Phase B: paste it at Admin → License Activation)</span>:</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-[#0a0d14]/70 border border-[#1e293b] rounded px-3 py-2 text-[#00f0ff] font-mono text-sm break-all">{installed.licenseKey}</code>
              <button onClick={() => copyKey(installed.licenseKey)} className="px-3 py-2 rounded border border-[#00f0ff] text-[#00f0ff] text-xs">
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
          {installed.plugins?.length > 0 && (
            <div className="text-[11px] text-emerald-200">Installed plugins: {installed.plugins.join(", ")}</div>
          )}
          <div className="flex flex-wrap gap-2">
            <a href={installed.loginUrl} target="_blank" rel="noreferrer"
              className="inline-block px-4 py-2 rounded bg-[#00f0ff] text-black font-bold text-xs">
              Go to Admin Login &amp; Activate
            </a>
            <a href={`/orders/${order.id}`}
              className="inline-block px-4 py-2 rounded border border-[#1e293b] text-slate-300 text-xs">
              Bookmark your order status
            </a>
          </div>
        </div>
      ) : success && (
        <div className="rounded-lg border border-emerald-500/50 bg-emerald-500/10 p-4 space-y-3">
          <div className="text-emerald-300 font-bold">Your server is ready</div>
          <div className="text-[11px] text-emerald-200">
            Activation page: <span className="font-mono break-all">{success.activateUrl}</span>
          </div>
          <div>
            <div className="text-[11px] text-emerald-200 mb-1">Your license key (saved to your email too):</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-[#0a0d14]/70 border border-[#1e293b] rounded px-3 py-2 text-[#00f0ff] font-mono text-sm break-all">{success.licenseKey}</code>
              <button onClick={() => copyKey()} className="px-3 py-2 rounded border border-[#00f0ff] text-[#00f0ff] text-xs">
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            {success.expiresAt && (
              <div className="text-[11px] text-emerald-200 mt-1">Valid until {new Date(success.expiresAt).toLocaleDateString()}</div>
            )}
          </div>
          <a href={success.activateUrl} target="_blank" rel="noreferrer"
            className="inline-block px-4 py-2 rounded bg-[#00f0ff] text-black font-bold text-xs">
            Open activation page
          </a>
          <a href={`/orders/${order.id}`}
            className="inline-block px-4 py-2 rounded border border-[#1e293b] text-slate-300 text-xs ml-2">
            Bookmark your order status
          </a>
          <div className="text-[11px] text-emerald-200">
            Paste the key there and press Activate - the full app (core + your package plugins) installs automatically.
          </div>
        </div>
      )}

      <div className="text-[11px] text-slate-400 space-y-1 max-h-48 overflow-y-auto font-mono">
        {log.map((l: string, i: number) => <div key={i}>{l}</div>)}
      </div>

      {!installed && !success && (
        <button onClick={run} disabled={running || (manualMode && connState !== "ready")}
          title={manualMode && connState !== "ready" ? "Press Test Connection first" : undefined}
          className="px-4 py-2 rounded border border-[#00f0ff] text-[#00f0ff] font-bold disabled:opacity-50">
          {running ? "Running setup..." : failure ? "Retry automation" : "2. Run Deploy & Install (1–100%)"}
        </button>
      )}
      {manualMode && connState !== "ready" && !installed && (
        <div className="text-[10px] text-slate-500">Deploy unlocks after a green “Environment Ready ✅” test.</div>
      )}
    </div>
  );
}
