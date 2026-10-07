"use client";
import React, { use, useCallback, useEffect, useState } from "react";
import { BootstrapRunner } from "@/app/pricing/order-form";
import { fetchJson } from "@/lib/safeJson";

/**
 * Customer order tracking / resume page: /orders/<orderId>
 *
 * Safe to bookmark. If the browser is closed mid-setup the customer can come
 * back here and press "Retry automation" — the bootstrap resumes from the
 * failed step and always shows a clear reason plus manual recovery steps.
 */

type NextStep = { kind: string; title: string; description?: string; actionUrl?: string; actionLabel?: string };

const STATUS_STYLE: Record<string, string> = {
  pending_payment: "border-amber-500/50 text-amber-300",
  pending_review: "border-amber-500/50 text-amber-300",
  paid: "border-[#00f0ff]/50 text-[#00f0ff]",
  bootstrap_running: "border-[#00f0ff]/50 text-[#00f0ff]",
  bootstrap_done: "border-emerald-500/50 text-emerald-300",
  install_running: "border-[#00f0ff]/50 text-[#00f0ff]",
  completed: "border-emerald-500/50 text-emerald-300",
  failed: "border-rose-500/50 text-rose-300",
  cancelled: "border-slate-600 text-slate-400",
};

/**
 * Next 15 hands a page its `params` as a Promise. In a client component you
 * unwrap it with React.use() during render, which is why `id` below is a plain
 * string and can stay a useCallback dependency.
 */
export default function OrderTrackingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [showRunner, setShowRunner] = useState(false);

  const load = useCallback(async () => {
    try {
      // NEVER `res.json()` directly here: this runs every 15s while the setup is
      // in flight, and a single empty response (crash, proxy timeout, storage
      // blip) threw "Failed to execute 'json' on 'Response': Unexpected end of
      // JSON input", blanked the page and froze the progress view. fetchJson
      // returns a safe object instead, so a bad poll can never break the page.
      const { data: d } = await fetchJson(`/api/orders/${id}`, { cache: "no-store" });
      if (!d?.success) {
        // Only surface a hard error when there is nothing to show. A failed
        // background poll must never replace a page that is already working.
        // The functional update reads the latest `data` without needing it as a
        // useCallback dependency (no stale closure).
        setError((prev) => (prev ? prev : d?.error || "Order not found."));
      } else {
        setData(d);
        setProgress(d.order?.progressPercent || 0);
        setError("");
      }
    } catch (e: any) {
      setError(e?.message || "Could not load the order.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Refresh the status every 15s while setup is in flight.
  useEffect(() => {
    if (!data) return;
    const live = ["bootstrap_running", "install_running", "paid", "failed"].includes(data.order?.status);
    if (!live) return;
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [data, load]);

  if (loading) {
    return <div className="min-h-screen bg-[#0a0d14] text-slate-300 font-mono p-4 sm:p-8">Loading your order…</div>;
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#0a0d14] text-slate-100 font-mono p-4 sm:p-8 w-full overflow-x-hidden">
        <div className="max-w-2xl mx-auto rounded-xl border border-rose-500/50 bg-rose-500/10 p-5">
          <div className="font-bold text-rose-300">We could not load this order</div>
          <div className="text-xs mt-2 text-rose-200">{error}</div>
          <div className="text-xs mt-3 text-slate-300">
            Check the link in your email, or contact support with your order ID: <b>{id}</b>
          </div>
        </div>
      </div>
    );
  }

  const o = data.order;
  const next: NextStep = data.nextStep || {};
  const badge = STATUS_STYLE[o.status] || "border-slate-600 text-slate-300";


  return (
    <div className="min-h-screen bg-[#0a0d14] text-slate-100 font-mono text-sm p-4 sm:p-6 w-full overflow-x-hidden">
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="rounded-xl border border-[#1e293b] bg-[#111625] p-5">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="text-lg font-extrabold text-white">Your Slate order</div>
            <span className={`px-3 py-1 rounded-full border text-[11px] font-bold ${badge}`}>
              {String(o.status).replace(/_/g, " ").toUpperCase()}
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-4 text-xs">
            <Row label="Order" value={o.id} />
            <Row label="Package" value={data.package?.name || "-"} />
            <Row label="Billing" value={o.billing_cycle} />
            <Row label="Site URL" value={o.siteUrl} />
            <Row label="Server path" value={o.fileManagerPath} />
            <Row label="Database" value={o.dbName || "not created yet"} />
            <Row label="Email" value={o.contactEmail} />
            <Row label="License key" value={o.licenseKeyLast4 ? `****${o.licenseKeyLast4}` : "not issued yet"} />
          </div>
          {data.package?.pluginSet?.length ? (
            <div className="text-xs text-[#00f0ff] mt-3">
              Plugins included: {data.package.pluginSet.join(" + ")}
            </div>
          ) : null}
        </div>

        <div className="rounded-xl border border-[#1e293b] bg-[#111625] p-5 space-y-3">
          <div className="font-bold text-white">{next.title}</div>
          {next.description && <div className="text-xs text-slate-300">{next.description}</div>}
          {o.error && o.status === "failed" && (
            <div className="text-xs text-rose-300 rounded border border-rose-500/40 bg-rose-500/10 p-3">
              Last error: {o.error}
            </div>
          )}
          <div className="h-2 rounded-full bg-[#0a0d14] border border-[#1e293b] overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-[#00f0ff] to-emerald-500 transition-all"
              style={{ width: `${Math.max(2, Math.min(100, o.progressPercent || 0))}%` }}
            />
          </div>
          <div className="text-[11px] text-slate-400">
            {o.progressStage} · {o.progressPercent || 0}%
          </div>
          <div className="flex flex-wrap gap-2">
            {next.actionUrl && (
              <a href={next.actionUrl} className="px-4 py-2 rounded bg-[#00f0ff] text-black font-bold text-xs">
                {next.actionLabel || "Continue"}
              </a>
            )}
            {(next.kind === "setup" || next.kind === "running" || next.kind === "activate" || next.kind === "install") && (
              <button
                onClick={() => setShowRunner(true)}
                className="px-4 py-2 rounded border border-[#00f0ff] text-[#00f0ff] font-bold text-xs"
              >
                {(next.kind === "activate" || next.kind === "install") ? "Re-run setup (files missing?)" : (next.actionLabel || "Run setup")}
              </button>
            )}
            <button onClick={load} className="px-4 py-2 rounded border border-[#1e293b] text-slate-300 text-xs">
              Refresh status
            </button>
            {Boolean(o.dbName || o.status === "failed") && (
              <button
                onClick={async () => {
                  if (!confirm("Reset database credentials for this order? This allows re-provisioning or fresh database setup.")) return;
                  try {
                    const res = await fetch(`/api/orders/${o.id}`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "reset_database" }),
                    });
                    const d = await res.json();
                    if (d.success) {
                      alert("Database configuration cleared.");
                      load();
                    } else {
                      alert(d.error || "Reset failed.");
                    }
                  } catch (e: any) {
                    alert(e.message || "Failed to reset database.");
                  }
                }}
                className="px-4 py-2 rounded border border-rose-500/50 text-rose-300 hover:bg-rose-500/10 text-xs"
              >
                Reset Database
              </button>
            )}
            <a href={`/api/orders/${o.id}/invoice`} target="_blank" rel="noreferrer"
              className="px-4 py-2 rounded border border-[#1e293b] text-slate-300 text-xs">
              🧾 Invoice
            </a>
            <a href={`/api/orders/${o.id}/download-auth`}
              className="px-4 py-2 rounded border border-[#1e293b] text-slate-300 text-xs">
              ⬇ auth.php
            </a>
          </div>
        </div>

        {showRunner && (
          <BootstrapRunner
            order={o}
            progress={progress}
            setProgress={setProgress}
            log={log}
            setLog={setLog}
          />
        )}

        <SelfEditPanel order={o} onSaved={load} />

        <div className="text-[11px] text-slate-500">
          Bookmark this page - you can return any time to check progress, fix your details or retry the setup. Nothing is lost on a retry.
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-slate-500 min-w-[92px]">{label}</span>
      <span className="text-slate-200 break-all">{value}</span>
    </div>
  );
}
/**
 * Customer self-service edit — wrong details can be fixed without support.
 *
 * There is no customer login on the public pages, so the guard is something the
 * customer physically holds: the exact email address stored on the order. That
 * email can never be changed without matching it first (a wrong email typed at
 * checkout is corrected by support, so nobody can hijack someone else's order).
 *
 * Only the customer's own data is editable here. Price, package, billing cycle,
 * payment status and progress stay Master-only — those are the money path.
 */
function SelfEditPanel({ order, onSaved }: { order: any; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    verifyEmail: "",
    contactName: order.contactName || "",
    contactPhone: order.contactPhone || "",
    contactEmail: "",
    siteDomain: String(order.siteUrl || "").replace(/^https?:\/\//i, ""),
    hostingUsername: order.hostingUsername || order.cpanelUser || "",
    hostingServerUrl: order.hostingServerUrl || order.cpanelHost || "",
    payMethod: order.payMethod || "manual_bank",
    clearDatabase: false,
  });

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(""); setDone([]); setWarnings([]);
    const patch: any = {
      verifyEmail: form.verifyEmail,
      contactName: form.contactName,
      contactPhone: form.contactPhone,
      siteDomain: form.siteDomain,
      hostingUsername: form.hostingUsername,
      hostingServerUrl: form.hostingServerUrl,
      payMethod: form.payMethod,
    };
    if (form.contactEmail && form.contactEmail !== order.contactEmail) patch.contactEmail = form.contactEmail;
    if (form.clearDatabase) patch.clearDatabase = true;

    try {
      const { data: d } = await fetchJson(`/api/orders/${order.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
      });
      if (!d?.success) { setError(d?.error || "Your changes could not be saved."); return; }
      setDone(d.edited || []);
      setWarnings(d.warnings || []);
      setOpen(false);
      onSaved();
    } catch (err: any) {
      setError(err?.message || "Network problem — please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border-[#1e293b] bg-[#111625] p-5 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <div className="font-bold text-white">Your details</div>
          <div className="text-[11px] text-slate-400">
            Typed something wrong? Fix your contact info, site URL, server path or cPanel details here — support sees it immediately.
          </div>
        </div>
        <button onClick={() => setOpen((v) => !v)} className="px-4 py-2 rounded border-[#00f0ff] text-[#00f0ff] font-bold text-xs">
          {open ? "Cancel" : "Edit my details"}
        </button>
      </div>

      {done.length > 0 && (
        <div className="rounded-lg border-emerald-500/50 bg-emerald-500/10 p-3">
          <div className="text-emerald-300 font-bold text-xs">Saved</div>
          <div className="text-[11px] text-emerald-200">Updated: {done.join(", ")}</div>
        </div>
      )}
      {warnings.map((w, i) => (
        <div key={i} className="rounded-lg border-amber-500/40 bg-amber-500/10 p-3 text-[11px] text-amber-200">{w}</div>
      ))}

      {open && (
        <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-[#1e293b]">
          <div className="md:col-span-2 rounded border-[#00f0ff]/40 bg-[#00f0ff]/5 p-3">
            <label className="block text-[11px] text-[#00f0ff] mb-1 uppercase">Confirm your email to unlock editing *</label>
            <input value={form.verifyEmail} onChange={(e) => set("verifyEmail", e.target.value)} required
              placeholder="The exact email you used on this order"
              className="w-full bg-[#0a0d14] border-[#1e293b] rounded px-3 py-2 text-white text-xs" />
            <div className="text-[10px] text-slate-400 mt-1">
              This is your only password. Use the email from your confirmation — support can fix it if you typed it wrong there.
            </div>
          </div>

          <EditRow label="Name" value={form.contactName} onChange={(v) => set("contactName", v)} />
          <EditRow label="Phone" value={form.contactPhone} onChange={(v) => set("contactPhone", v)} />
          <EditRow label="Email (leave blank to keep)" value={form.contactEmail} onChange={(v) => set("contactEmail", v)} placeholder={order.contactEmail} />
          <EditRow label="Site domain (client.com or client.com/crm)" value={form.siteDomain} onChange={(v) => set("siteDomain", v)} placeholder="client.com" />
          <EditRow label="Hosting username" value={form.hostingUsername} onChange={(v) => set("hostingUsername", v)} />
          <EditRow label="Hosting server URL" value={form.hostingServerUrl} onChange={(v) => set("hostingServerUrl", v)} placeholder="https://cpanel.client.com:2083" />

          <div>
            <label className="block text-slate-400 mb-1 uppercase">Payment method</label>
            <select value={form.payMethod} onChange={(e) => set("payMethod", e.target.value)}
              className="w-full bg-[#0a0d14] border-[#1e293b] rounded px-3 py-2 text-white text-xs">
              <option value="manual_bank">Bank transfer (manual approve)</option>
              <option value="manual_cod">Cash on delivery (manual approve)</option>
              <option value="manual_custom">Custom (manual approve)</option>
              <option value="stripe">Stripe (auto on webhook)</option>
            </select>
          </div>

          <div className="md:col-span-2 pt-1">
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={form.clearDatabase}
                onChange={(e) => setForm((f) => ({ ...f, clearDatabase: e.target.checked }))}
                className="rounded border-[#1e293b] bg-[#0a0d14]"
              />
              Reset / clear database credentials (allows fresh database provisioning)
            </label>
          </div>

          {error && <div className="md:col-span-2 rounded border-rose-500/50 bg-rose-500/10 p-3 text-[11px] text-rose-200">{error}</div>}

          <div className="md:col-span-2 flex justify-end gap-2">
            <button disabled={busy} className="px-5 py-2 rounded bg-[#00f0ff] text-black font-bold text-xs disabled:opacity-50">
              {busy ? "Saving…" : "Save my details"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function EditRow({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <label className="block text-slate-400 mb-1 uppercase">{label}</label>
      <input value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
        className="w-full bg-[#0a0d14] border-[#1e293b] rounded px-3 py-2 text-white text-xs" />
    </div>
  );
}
