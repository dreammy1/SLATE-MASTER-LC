"use client";
import React, { useState } from "react";

const FIELDS: Array<[string, string]> = [
  ["siteUrl", "Site URL (https://client.com/slate)"],
  ["fileManagerPath", "Site path (/public_html/slate)"],
  ["cpanelHost", "cPanel host (yourdomain.com)"],
  ["cpanelUser", "cPanel user (myhost_user)"],
  ["cpanelApiToken", "cPanel API token"],
  ["contactName", "Name"],
  ["contactPhone", "Phone"],
  ["contactEmail", "Email"],
];

export function OrderForm({ pkg, cycle, onOrder }: { pkg: any; cycle: string; onOrder: (o: any) => void }) {
  const [form, setForm] = useState({
    siteUrl: "", fileManagerPath: "/public_html/slate", cpanelHost: "", cpanelUser: "",
    cpanelApiToken: "", contactName: "", contactPhone: "", contactEmail: "", payMethod: "manual_bank",
  });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch("/api/orders", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package_id: pkg.id, billing_cycle: cycle, ...form }),
    });
    const d = await res.json();
    if (!d.success) { alert(d.error || "Order failed"); return; }
    onOrder(d.order);
  };
  return (
    <form onSubmit={submit} className="max-w-2xl mx-auto mt-6 rounded-xl p-5 border border-[#1e293b] bg-[#111625] grid grid-cols-1 md:grid-cols-2 gap-3">
      <div className="md:col-span-2 text-white font-bold">Server info → {pkg.name} / {cycle}</div>
      <div className="md:col-span-2 text-[11px] text-slate-400">
        Need help? cPanel → Security → Manage API Tokens. Use the full username (example: myhost_slate) and host without https://
      </div>
      {FIELDS.map(([k, ph]) => (
        <input key={k} value={(form as any)[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} placeholder={ph}
          className="bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white text-xs" />
      ))}
      <select value={form.payMethod} onChange={(e) => setForm({ ...form, payMethod: e.target.value })}
        className="bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white text-xs">
        <option value="manual_bank">Bank transfer (manual approve)</option>
        <option value="manual_cod">Cash on delivery (manual approve)</option>
        <option value="manual_custom">Custom (manual approve)</option>
        <option value="stripe">Stripe (auto on webhook)</option>
      </select>
      <div className="md:col-span-2 flex justify-end">
        <button className="px-5 py-2 rounded bg-[#00f0ff] text-black font-bold">Submit order</button>
      </div>
    </form>
  );
}

type Guide = { title: string; reason: string; steps: string[]; retryable?: boolean; retryLabel?: string; helpUrl?: string };
type Failure = { message: string; failedStage: string; percent: number; guide?: Guide };
type Success = { activateUrl: string; licenseKey: string; maskedKey: string; expiresAt: string | null; siteUrl: string; warnings: string[] };

const RETRY_STEPS = [
  "Nothing was lost and you were not charged twice.",
  "Press Retry automation - most temporary problems fix themselves on the second try.",
  "If it fails again, copy the red error text and send it to support with your order ID.",
];

export function BootstrapRunner({ order, progress, setProgress, log, setLog }: any) {
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<string>("");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [success, setSuccess] = useState<Success | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const run = async () => {
    setRunning(true); setFailure(null); setSuccess(null); setWarnings([]);
    setLog((l: string[]) => [...l, "Starting setup automation..."]);
    try {
      const res = await fetch("/api/deploy/bootstrap", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: order.id }),
      });
      if (!res.ok || !res.body) {
        const e = await res.json().catch(() => ({} as any));
        const reason = e.error || `Server responded ${res.status}`;
        setFailure({ message: reason, failedStage: "REQUEST", percent: progress, guide: e.guide || { title: "We could not start the setup", reason, steps: ["Confirm the payment is approved (order status should be paid).", ...RETRY_STEPS], retryable: true, retryLabel: "Retry automation" } });
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let lastEvent = Date.now();
      let sawDone = false;

      // Watchdog: the server sends a heartbeat every 10s. If nothing arrives for
      // 45s the stream died (proxy/browser dropped it) — surface a clear,
      // actionable error instead of leaving the bar frozen at some percentage.
      const watchdog = setInterval(() => {
        const idle = Date.now() - lastEvent;
        if (idle > 45_000 && !sawDone) {
          setFailure({
            message: `No update from the server for ${Math.round(idle / 1000)}s. The connection was dropped while running step "${stage || "setup"}".`,
            failedStage: stage || "CONNECTION",
            percent: progress,
            guide: {
              title: "The setup connection was interrupted",
              reason: "Your server may still be working, or the request was cut off by a proxy/timeout.",
              steps: [
                "Press Retry automation — the setup resumes from the step it stopped at and never duplicates work.",
                "Open your order status page to see the last recorded step before retrying.",
                "If it keeps dropping at the same step, send support the step name and your order ID.",
              ],
              retryable: true,
              retryLabel: "Retry automation",
            },
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
            if (ev.stage) setStage(ev.stage);
            if (typeof ev.percent === "number") setProgress(ev.percent);
            // Heartbeats keep the connection alive; they should not spam the log.
            if (ev.message && !ev.heartbeat) setLog((l: string[]) => [...l, `[${ev.percent ?? 0}%] ${ev.message}`]);
            if (Array.isArray(ev.warnings) && ev.warnings.length) setWarnings(ev.warnings);
            if (ev.error) {
              setFailure({ message: ev.error, failedStage: ev.failedStage || "UNKNOWN", percent: ev.percent ?? 0, guide: ev.guide });
            }
            if (ev.done) {
              sawDone = true;
              setSuccess({
                activateUrl: ev.activateUrl, licenseKey: ev.licenseKey, maskedKey: ev.maskedKey,
                expiresAt: ev.expiresAt ?? null, siteUrl: ev.siteUrl, warnings: ev.warnings || [],
              });
              setLog((l: string[]) => [...l, "Setup complete. Your server is ready."]);
            }
          }
        }
      } finally {
        clearInterval(watchdog);
      }
    } catch (err: any) {
      const reason = err?.message || "Network error";
      setFailure({ message: reason, failedStage: "NETWORK", percent: progress, guide: { title: "Connection problem", reason, steps: RETRY_STEPS, retryable: true, retryLabel: "Retry automation" } });
    } finally {
      setRunning(false);
    }
  };

  const copyKey = async () => {
    if (!success) return;
    try { await navigator.clipboard.writeText(success.licenseKey); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { /* ignore */ }
  };

  return (
    <div className="max-w-2xl mx-auto mt-6 rounded-xl p-5 border border-[#1e293b] bg-[#111625] space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-white font-bold">Order {order.id}</div>
        <span className="text-[11px] font-mono px-2 py-1 rounded border border-[#1e293b] text-slate-300">{order.status}</span>
      </div>

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

      {success && (
        <div className="rounded-lg border border-emerald-500/50 bg-emerald-500/10 p-4 space-y-3">
          <div className="text-emerald-300 font-bold">Your server is ready</div>
          <div className="text-[11px] text-emerald-200">
            Activation page: <span className="font-mono break-all">{success.activateUrl}</span>
          </div>
          <div>
            <div className="text-[11px] text-emerald-200 mb-1">Your license key (saved to your email too):</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-[#0a0d14]/70 border border-[#1e293b] rounded px-3 py-2 text-[#00f0ff] font-mono text-sm break-all">{success.licenseKey}</code>
              <button onClick={copyKey} className="px-3 py-2 rounded border border-[#00f0ff] text-[#00f0ff] text-xs">
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

      {!success && (
        <button onClick={run} disabled={running}
          className="px-4 py-2 rounded border border-[#00f0ff] text-[#00f0ff] font-bold disabled:opacity-50">
          {running ? "Running setup..." : failure ? "Retry automation" : "Run bootstrap 0-100%"}
        </button>
      )}
    </div>
  );
}
