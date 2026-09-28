"use client";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import FuturisticLayout from "@/components/FuturisticLayout";
import {
  KeyRound, Ban, Play, Plus, RefreshCw, Search, Pencil, Trash2, Activity,
  ShieldCheck, Eye, EyeOff, Server, Package as PkgIcon, Radio, HeartPulse, Wrench, Copy, Check, FileCog, AlertTriangle,
} from "lucide-react";

/* ────────────
 * CLIENT MANAGEMENT CONSOLE  (/licenses)
 *
 * One row per customer (order + license + live site aggregated by /api/clients).
 *   • payment status approve/edit, license status + expiry editing
 *   • Edit -> full drawer with EVERY stored field, live health probe, package
 *     info, license key, core version, active plugin list, remote access mode
 *     (readonly / full access) and Re-run bootstrap / Re-run setup streams.
 *   • Delete -> order + licenses (+ optionally the site record).
 * ──────────── */

const CYCLES = ["monthly", "yearly", "lifetime"];
const PAY_METHODS = ["stripe", "manual_bank", "manual_cod", "manual_custom"];
const ORDER_STATUSES = [
  "draft", "pending_payment", "pending_review", "paid",
  "bootstrap_running", "bootstrap_done", "install_running", "completed", "failed", "cancelled",
];
const LICENSE_STATUSES = ["trial", "active", "expired", "suspended", "revoked", "cancelled"];
const GROUPS = ["all", "active", "expiring", "expired", "unpaid", "failed", "completed", "readonly", "unlinked"];

const statusTone = (s: string) =>
  s === "completed" || s === "paid" || s === "active"
    ? "text-emerald-400"
    : s === "failed" || s === "expired" || s === "revoked" || s === "cancelled"
      ? "text-rose-400"
      : s === "pending_payment" || s === "pending_review" || s === "suspended"
        ? "text-amber-400"
        : "text-slate-300";

const fmtDate = (v: any) => (v ? new Date(v).toLocaleString() : "—");

export default function ClientConsolePage() {
  const [clients, setClients] = useState<any[]>([]);
  const [totals, setTotals] = useState<any>(null);
  const [groups, setGroups] = useState<string[]>(GROUPS);
  const [group, setGroup] = useState("all");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<any>(null);   // full client record drawer
  const [live, setLive] = useState<any>(null);        // health probe result
  const [liveBusy, setLiveBusy] = useState(false);
  const [streamLog, setStreamLog] = useState<string[]>([]);
  const [streaming, setStreaming] = useState<"" | "bootstrap" | "install">("");
  const [streamProgress, setStreamProgress] = useState(0);
  const [edit, setEdit] = useState<any>({});
  const [licenses, setLicenses] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (group !== "all") params.set("status", group);
    const c = await fetch(`/api/clients?${params}`).then((r) => r.json()).catch(() => ({}));
    if (c.success) { setClients(c.clients); setTotals(c.totals); if (c.groups) setGroups(c.groups); }
    const [l, o] = await Promise.all([
      fetch("/api/licenses").then((r) => r.json()).catch(() => ({})),
      fetch("/api/orders").then((r) => r.json()).catch(() => ({})),
    ]);
    if (l.success) setLicenses(l.licenses);
    if (o.success) setOrders(o.orders);
  }, [q, group]);

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  /* The license-key field can ask for a rotation when a key cannot be revealed. */
  useEffect(() => {
    const handler = () => { if (detail) action(detail.client.id, { action: "rotate_key", notify: true }); };
    window.addEventListener("slate-rotate-key", handler);
    return () => window.removeEventListener("slate-rotate-key", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail]);

  const openDetail = useCallback(async (id: string) => {
    setDetail(null); setLive(null); setStreamLog([]); setEdit({});
    const d = await fetch(`/api/clients/${id}`, { cache: "no-store" }).then((r) => r.json()).catch(() => ({}));
    if (!d.success) { alert(d.error || "Could not open the client."); return; }
    setDetail(d);
    setEdit({
      contactName: d.client.contactName || "",
      contactEmail: d.client.contactEmail || "",
      contactPhone: d.client.contactPhone || "",
      siteUrl: d.client.siteUrl || "",
      fileManagerPath: d.client.fileManagerPath || "",
      cpanelHost: d.order?.cpanelHost || "",
      cpanelUser: d.order?.cpanelUser || "",
      cpanelApiToken: "",
      package_id: d.client.packageId || "",
      billing_cycle: d.client.billingCycle || "monthly",
      payMethod: d.order?.payMethod || "manual_bank",
      status: d.client.paymentStatus || "pending_review",
      notes: d.order?.notes || "",
      license_status: d.client.license.status === "none" ? "active" : d.client.license.status,
      license_expires_at: d.client.license.expiresAt ? String(d.client.license.expiresAt).slice(0, 10) : "",
      activation_limit: d.client.license.activationLimit || 3,
      remoteAccess: d.client.remoteAccess || "unknown",
    });
  }, []);

  const probeHealth = async (id: string) => {
    setLiveBusy(true); setLive(null);
    try {
      const d = await fetch(`/api/clients/${id}/health`, { cache: "no-store" }).then((r) => r.json());
      setLive(d.success ? d : { error: d.error || "Health probe failed." });
    } catch (e: any) { setLive({ error: e?.message || "Health probe failed." }); }
    setLiveBusy(false);
  };

  const saveEdit = async () => {
    setBusy(true);
    const payload: any = { ...edit };
    if (!payload.cpanelApiToken) delete payload.cpanelApiToken;
    if (payload.remoteAccess === "unknown") delete payload.remoteAccess;
    const d = await fetch(`/api/clients/${detail.client.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    }).then((r) => r.json());
    setBusy(false);
    if (!d.success) { alert(d.error || "Save failed."); return; }
    alert(`Saved: ${(d.changed || []).join(", ") || "no changes"}`);
    await load();
    openDetail(detail.client.id);
  };

  const removeClient = async (id: string) => {
    const removeSite = confirm("ALSO delete the site record (monitoring, agent token)?\nOK = delete everything / Cancel = keep the site record.");
    const revoke = confirm("Push a license revoke to the live server first?");
    if (!confirm("Delete this client (order + licenses)? This cannot be undone.")) return;
    const d = await fetch(`/api/clients/${id}?site=${removeSite ? 1 : 0}&revoke=${revoke ? 1 : 0}`, { method: "DELETE" }).then((r) => r.json());
    if (!d.success) { alert(d.error || "Delete failed."); return; }
    setDetail(null);
    alert(d.message);
    load();
  };

  /* order-level quick actions from the list */
  const approveOrder = async (id: string) => {
    const d = await fetch("/api/orders", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action: "approve" }) }).then((r) => r.json());
    if (!d.success) alert(d.error || "Approve failed");
    load();
  };

  /* license lifecycle quick actions */
  const licAct = async (id: string, action: string, extra: any = {}) => {
    const d = await fetch("/api/licenses/lifecycle", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action, ...extra }) }).then((r) => r.json());
    if (!d.success && !d.license) { alert(d.error || "Failed"); return; }
    if (d.key) alert(`New key (once): ${d.key}`);
    load();
  };

  /* remote access push + key rotation + license sync + cPanel test */
  const action = async (id: string, body: any) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/clients/${id}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok || !d.success) {
        // Repair attempts every layout — show which ones were tried so support
        // can see the real reason instead of a generic failure.
        if (body.action === "repair_files" && Array.isArray(d.attempts) && d.attempts.length) {
          alert(`${d.error || d.message}\n\nLayouts tried:\n${d.attempts.map((a: any, i: number) => `${i + 1}. ${a.strategy} → ${a.remoteDir} @ ${a.siteUrl}\n   ${a.ok ? "OK" : a.reason}`).join("\n")}`);
        } else alert(d.error || d.message || "Action failed.");
      } else if (body.action === "repair_files") {
        alert(`${d.message}\n\nPlaced in: ${d.target?.remoteDir}\nPublic URL: ${d.target?.siteUrl}\n${d.agentUrl ? `Agent: ${d.agentUrl}` : ""}`);
      } else if (body.action === "write_config") {
        alert(d.message || "Configuration written.");
      } else if (body.action === "rotate_key") {
        if (confirm(`${d.message}\n\nShow the new license key now? (it is also emailed to the client)`)) prompt("New license key (copy it now):", d.key);
      } else alert(d.message || "Done.");
    } catch (e: any) { alert(e?.message || "Action failed."); }
    setBusy(false);
    load();
    if (detail) openDetail(detail.client.id);
  };

  /* Re-run bootstrap / full setup: both stream NDJSON just like the public page */
  const readStream = async (respBody: ReadableStream<Uint8Array>, label: string) => {
    const reader = respBody.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev: any; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.heartbeat) { setStreamLog((l) => [...l, `~ ${ev.message}`]); continue; }
        if (typeof ev.percent === "number") setStreamProgress(ev.percent);
        if (ev.message) setStreamLog((l) => [...l, `[${ev.percent ?? "?"}%] ${ev.message}`]);
        if (ev.error) setStreamLog((l) => [...l, `ERROR (${ev.failedStage || "?"}): ${ev.error}`]);
        if (ev.done) setStreamLog((l) => [...l, `${label} complete.`]);
      }
    }
  };

  const runStream = async (kind: "bootstrap" | "install") => {
    const o = detail.order;
    if (!o) { alert("This client has no order, so setup cannot be re-run."); return; }

    if (kind === "install") {
      const rawKey = prompt("Full setup needs the client's LICENSE KEY (it is in the confirmation email):");
      if (!rawKey) return;
      setStreaming("install"); setStreamLog([`[0%] Re-running full setup for ${o.siteUrl}…`]); setStreamProgress(0);
      try {
        const res = await fetch("/api/deploy/full-install", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: rawKey.trim(), domain: o.siteUrl }),
        });
        if (!res.ok || !res.body) { const e = await res.json().catch(() => ({})); alert(e.error || `Server responded ${res.status}`); setStreaming(""); return; }
        await readStream(res.body, "Full setup");
      } catch (e: any) { setStreamLog((l) => [...l, `Connection lost: ${e?.message || e}`]); }
      setStreaming(""); load(); openDetail(detail.client.id);
      return;
    }

    setStreaming("bootstrap"); setStreamLog([`[0%] Re-running bootstrap for order ${o.id}…`]); setStreamProgress(0);
    try {
      const res = await fetch("/api/deploy/bootstrap", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId: o.id }),
      });
      if (!res.ok || !res.body) { const e = await res.json().catch(() => ({})); alert(e.error || `Server responded ${res.status}`); setStreaming(""); return; }
      await readStream(res.body, "Bootstrap");
    } catch (e: any) { setStreamLog((l) => [...l, `Connection lost: ${e?.message || e}`]); }
    setStreaming(""); load(); openDetail(detail.client.id);
  };

  const totalsBadge = useMemo(() => totals ? (
    <span className="text-slate-400 text-[11px]">
      {totals.clients} clients · <span className="text-emerald-400">{totals.active} active</span> · <span className="text-amber-400">{totals.expiringSoon} expiring</span> · <span className="text-rose-400">{totals.expired} expired</span> · {totals.awaitingPayment} unpaid
    </span>
  ) : null, [totals]);

  return (
    <FuturisticLayout activeTab="licenses">
      <div className="space-y-6 font-mono text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-extrabold text-white flex items-center gap-2"><KeyRound className="w-6 h-6 text-[#00f0ff]" /> CLIENT MANAGEMENT</h2>
          {totalsBadge}
        </div>

        <MasterUrlBanner />

        {/* ── search + groups ─────────── */}
        <div className="glass-panel rounded-xl p-4 border-[#1e293b] space-y-3">
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-slate-500" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name / email / site / package / key…"
              className="flex-1 bg-[#0a0d14] border-[#1e293b] rounded px-3 py-2 text-white" />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {groups.map((g) => (
              <button key={g} onClick={() => setGroup(g)}
                className={`px-3 py-1 rounded-full border ${group === g ? "border-[#00f0ff] text-[#00f0ff]" : "border-[#1e293b] text-slate-400"}`}>{g}</button>
            ))}
          </div>

          {/* ── client table ──────────── */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead>
                <tr className="text-slate-500 text-left border-b border-[#1e293b]">
                  <th className="py-2 pr-3">Client</th><th className="py-2 pr-3">Site</th><th className="py-2 pr-3">Package</th>
                  <th className="py-2 pr-3">Payment</th><th className="py-2 pr-3">License</th><th className="py-2 pr-3">Health</th>
                  <th className="py-2 pr-3">Access</th><th className="py-2 pr-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.id} className="border-b border-[#1e293b]/60 hover:bg-[#0a0d14]/60">
                    <td className="py-2 pr-3">
                      <div className="text-white font-bold">{c.contactName || <span className="text-slate-500">(no name)</span>}</div>
                      <div className="text-slate-500">{c.contactEmailMasked || c.orderId}</div>
                    </td>
                    <td className="py-2 pr-3 text-slate-300 break-all max-w-[220px]">
                      {c.siteUrl}
                      <div className="text-slate-500">{c.siteStatus} · {c.latency}</div>
                    </td>
                    <td className="py-2 pr-3 text-slate-300">{c.packageName}</td>
                    <td className={`py-2 pr-3 font-bold ${statusTone(c.paymentStatus)}`}>{String(c.paymentStatus).replace(/_/g, " ")}</td>
                    <td className="py-2 pr-3">
                      <span className={`font-bold ${c.license.effective === "active" ? "text-emerald-400" : c.license.effective === "expired" ? "text-rose-400" : "text-slate-300"}`}>
                        {c.license.effective.toUpperCase()}
                      </span>
                      {c.license.expiresAt && (
                        <div className={c.license.expiringSoon ? "text-amber-400" : "text-slate-500"}>
                          {c.license.daysLeft !== null && c.license.daysLeft < 0
                            ? `expired ${Math.abs(c.license.daysLeft)}d ago`
                            : `${c.license.daysLeft ?? "?"}d left`} · {new Date(c.license.expiresAt).toLocaleDateString()}
                        </div>
                      )}
                      {c.license.lifetime && <div className="text-slate-500">lifetime</div>}
                    </td>
                    <td className="py-2 pr-3">
                      <span className={c.lastHealthStatus === "ONLINE" ? "text-emerald-400" : c.lastHealthStatus === "OFFLINE" ? "text-rose-400" : "text-slate-500"}>
                        {c.lastHealthStatus || "not probed"}
                      </span>
                    </td>
                    <td className="py-2 pr-3">
                      <span className={c.remoteAccess === "readonly" ? "text-amber-400" : c.remoteAccess === "full" ? "text-emerald-400" : "text-slate-500"}>
                        {c.remoteAccess}
                      </span>
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex justify-end gap-1">
                        <button title="Open client (full data, health, remote ops)" onClick={() => openDetail(c.id)}
                          className="p-1.5 border-[#00f0ff] text-[#00f0ff] rounded"><Pencil className="w-3.5 h-3.5" /></button>
                        <button title="Delete client" onClick={() => removeClient(c.id)}
                          className="p-1.5 border-rose-500 text-rose-400 rounded"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {clients.length === 0 && <div className="text-slate-500 py-3">No clients in this view. Orders placed at /pricing appear here automatically.</div>}
          </div>
        </div>

        {/* ── raw orders (approve queue) ──────────────── */}
        <div className="glass-panel rounded-xl p-4 border-[#1e293b]">
          <div className="text-slate-300 font-bold mb-2 flex items-center gap-2"><Plus className="w-4 h-4" /> ORDER QUEUE (manual approve → paid)</div>
          {orders.map((o) => (
            <div key={o.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-1.5 border-b border-[#1e293b]">
              <span className="text-slate-300 min-w-0">{o.id} · {o.siteUrl} · {o.billing_cycle} · <b className={statusTone(o.status)}>{o.status}</b> · {o.contactEmail}</span>
              <span className="flex gap-1 shrink-0">
                <button onClick={() => openDetail(o.id)} className="px-3 py-1 rounded border-[#00f0ff] text-[#00f0ff]">Manage</button>
                {o.status === "pending_review" && <button onClick={() => approveOrder(o.id)} className="px-3 py-1 rounded border-emerald-500 text-emerald-400">Approve payment</button>}
              </span>
            </div>
          ))}
          {orders.length === 0 && <div className="text-slate-500">No orders yet. Create one at /pricing.</div>}
        </div>

        {/* ── raw licenses (quick lifecycle) ─────────── */}
        <div className="glass-panel rounded-xl p-4 border-[#1e293b]">
          <div className="text-slate-300 font-bold mb-2">LICENSE ROWS (quick lifecycle — full control is inside the client drawer)</div>
          {licenses.map((l) => (
            <div key={l.id} className="flex flex-wrap items-center gap-2 py-1.5 border-b border-[#1e293b]">
              <span className="text-slate-300">{l.domain} · {l.package_slug} · ****{l.key_last4} · <b>{l.status}</b> · exp {l.expires_at ?? "lifetime"} · act {l.activation_count}/{l.activation_limit}</span>
              <span className="flex gap-1 ml-auto">
                <button title="Suspend" onClick={() => licAct(l.id, "suspend")} className="p-1.5 border-amber-500 text-amber-400 rounded"><Ban className="w-3.5 h-3.5" /></button>
                <button title="Reactivate" onClick={() => licAct(l.id, "activate")} className="p-1.5 border-emerald-500 text-emerald-400 rounded"><Play className="w-3.5 h-3.5" /></button>
                <button title="Renew (new key)" onClick={() => licAct(l.id, "renew")} className="p-1.5 border-[#00f0ff] text-[#00f0ff] rounded"><RefreshCw className="w-3.5 h-3.5" /></button>
                <button title="Revoke" onClick={() => { if (confirm("Revoke this license?")) licAct(l.id, "revoke"); }} className="p-1.5 border-rose-500 text-rose-400 rounded">Revoke</button>
              </span>
            </div>
          ))}
          {licenses.length === 0 && <div className="text-slate-500">No licenses yet.</div>}
        </div>
      </div>

      {/* ════ DETAIL / EDIT DRAWER ════ */}
      {detail && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/70" onClick={() => setDetail(null)}>
          <div className="w-full max-w-3xl h-full overflow-y-auto bg-[#0d1220] border-l border-[#1e293b] p-4 sm:p-6 space-y-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-extrabold text-white flex items-center gap-2">
                  <Server className="w-5 h-5 text-[#00f0ff]" /> {detail.client.contactName || detail.client.siteUrl || detail.client.id}
                </div>
                <div className="text-slate-500 text-[11px]">Order {detail.client.orderId || "—"} · created {fmtDate(detail.client.createdAt)}</div>
              </div>
              <button onClick={() => setDetail(null)} className="px-3 py-1 border-[#1e293b] text-slate-400 rounded">Close</button>
            </div>

            {/* status strip */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <Stat label="Payment" value={String(detail.client.paymentStatus).replace(/_/g, " ")} tone={statusTone(detail.client.paymentStatus)} />
              <Stat label="License" value={detail.client.license.effective.toUpperCase()} tone={statusTone(detail.client.license.effective)} />
              <Stat label="Expiry" value={detail.client.license.lifetime ? "lifetime" : detail.client.license.expiresAt ? `${detail.client.license.daysLeft}d left` : "—"} tone={detail.client.license.expiringSoon ? "text-amber-400" : "text-slate-200"} />
              <Stat label="Health" value={detail.client.lastHealthStatus || "not probed"} tone={detail.client.lastHealthStatus === "ONLINE" ? "text-emerald-400" : "text-slate-200"} />
            </div>

            {/* purchased package + license key + versions */}
            <Panel icon={<PkgIcon className="w-4 h-4 text-[#00f0ff]" />} title="PURCHASED PACKAGE & LICENSE">
              <div className="grid md:grid-cols-2 gap-2 text-slate-300">
                <KV k="Package" v={`${detail.package?.name || detail.client.packageName} (${detail.package?.slug || detail.client.packageSlug || "?"})`} />
                <KV k="Billing cycle" v={detail.client.billingCycle || "—"} />
                <KV k="Price (this cycle)" v={detail.package ? `${detail.client.billingCycle === "yearly"
                  ? (detail.package.pricing.yearly_cents / 100).toFixed(2)
                  : detail.client.billingCycle === "lifetime"
                    ? (detail.package.pricing.lifetime_cents / 100).toFixed(2)
                    : (detail.package.pricing.monthly_cents / 100).toFixed(2)
                  } ${detail.package.pricing.currency}` : "—"} />
                <LicenseKeyField clientId={detail.client.id} last4={detail.client.license.keyLast4} />
                <KV k="Activations" v={`${detail.client.license.activationCount}/${detail.client.license.activationLimit || "∞"}`} />
                <KV k="License last seen" v={fmtDate(detail.client.license.lastSeenAt)} />
                <KV k="Slate core version" v={detail.client.coreVersion || "unknown (probe health)"} />
                <KV k="Agent version" v={detail.client.agentVersion || "unknown"} />
                <KV k="Included plugins" v={(detail.client.pluginSet || []).join(", ") || "—"} />
                <KV k="Active plugins (stored)" v={(detail.client.activePlugins || []).join(", ") || "—"} />
                <KV k="Payment method" v={detail.order?.payMethod || "—"} />
                <KV k="Progress" v={`${detail.client.progressPercent}% · ${detail.client.progressStage || ""}`} />
              </div>
            </Panel>

            {/* live health */}
            <Panel icon={<HeartPulse className="w-4 h-4 text-[#00f0ff]" />} title="LIVE SITE HEALTH"
              right={<button onClick={() => probeHealth(detail.client.id)} disabled={liveBusy}
                className="px-3 py-1 border-[#00f0ff] text-[#00f0ff] rounded flex items-center gap-1 disabled:opacity-50"><Activity className="w-3.5 h-3.5" />{liveBusy ? "Probing…" : "Probe now"}</button>}>
              {liveBusy && <div className="text-slate-500">Probing HTTP + agent + installer…</div>}
              {!liveBusy && !live && <div className="text-slate-500">Last probed: {fmtDate(detail.client.lastHealthAt)} — press “Probe now” for a live check.</div>}
              {live?.error && <div className="text-rose-400">{live.error}</div>}
              {live?.health && (
                <div className="space-y-2">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    <Stat label="HTTP" value={`${live.health.http.ok ? "OK" : "FAIL"} ${live.health.http.statusCode ?? ""} · ${live.health.http.latencyMs ?? "?"}ms`} tone={live.health.http.ok ? "text-emerald-400" : "text-rose-400"} />
                    <Stat label="Agent" value={live.health.agent.message || (live.health.agent.reachable ? "online" : "unreachable")} tone={live.health.agent.reachable ? "text-emerald-400" : "text-rose-400"} />
                    <Stat label="Installer" value={`${live.health.installer.reachable ? (live.health.installer.installed ? "installed" : "not installed") : "unreachable"}${live.health.installer.db_ok === false ? " · DB FAIL" : ""}`} tone={live.health.installer.reachable && live.health.installer.installed ? "text-emerald-400" : "text-amber-400"} />
                  </div>
                  <div className="text-slate-400">
                    Core: <b className="text-slate-200">{live.health.overview.coreVersion || "?"}</b> · PHP: <b className="text-slate-200">{live.health.overview.phpVersion || "?"}</b> · Server: <b className="text-slate-200">{live.health.overview.serverSoftware || "?"}</b>
                  </div>
                  {live.health.overview.partial && <div className="text-amber-400">{live.health.overview.message}</div>}
                  {Array.isArray(live.health.overview.plugins) && live.health.overview.plugins.length > 0 && (
                    <div>
                      <div className="text-slate-400 mb-1">Plugins on the live site ({live.health.overview.plugins.filter((p: any) => p.active).length}/{live.health.overview.plugins.length} active):</div>
                      <div className="flex flex-wrap gap-1">
                        {live.health.overview.plugins.map((p: any) => (
                          <span key={p.slug} className={`px-2 py-0.5 rounded-full border ${p.active ? "border-emerald-500 text-emerald-300" : "border-[#1e293b] text-slate-500"}`}>{p.name || p.slug}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </Panel>

            {/* remote management */}
            <Panel icon={<Radio className="w-4 h-4 text-[#00f0ff]" />} title="REMOTE MANAGEMENT (AGENT)">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-slate-400">Current mode:</span>
                <span className={`px-2 py-0.5 rounded-full border flex items-center gap-1 ${detail.client.remoteAccess === "readonly" ? "border-amber-500 text-amber-300" : detail.client.remoteAccess === "full" ? "border-emerald-500 text-emerald-300" : "border-[#1e293b] text-slate-500"}`}>
                  {detail.client.remoteAccess === "readonly" ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                  {detail.client.remoteAccess}
                </span>
                {detail.client.remoteAccessUpdatedAt && <span className="text-slate-500">pushed {fmtDate(detail.client.remoteAccessUpdatedAt)}</span>}
              </div>
              <div className="flex flex-wrap gap-2">
                <button disabled={busy} onClick={() => action(detail.client.id, { action: "remote_access", mode: "readonly" })}
                  className="px-3 py-1 border-amber-500 text-amber-400 rounded flex items-center gap-1 disabled:opacity-50"><EyeOff className="w-3.5 h-3.5" /> Set READ-ONLY</button>
                <button disabled={busy} onClick={() => action(detail.client.id, { action: "remote_access", mode: "full" })}
                  className="px-3 py-1 border-emerald-500 text-emerald-400 rounded flex items-center gap-1 disabled:opacity-50"><ShieldCheck className="w-3.5 h-3.5" /> Set FULL ACCESS</button>
                <button disabled={busy} onClick={() => action(detail.client.id, { action: "rotate_key", notify: true })}
                  className="px-3 py-1 border-[#00f0ff] text-[#00f0ff] rounded disabled:opacity-50">Rotate license key</button>
                <button disabled={busy} onClick={() => action(detail.client.id, { action: "sync_license" })}
                  className="px-3 py-1 border-[#1e293b] text-slate-300 rounded disabled:opacity-50">Sync license from agent</button>
                <button disabled={busy} onClick={() => action(detail.client.id, { action: "test_cpanel" })}
                  className="px-3 py-1 border-[#1e293b] text-slate-300 rounded disabled:opacity-50">Test cPanel login</button>
                <button disabled={busy}
                  title="Re-place auth.php + activate.php and re-pair the agent token. Does not touch the database, license or app files."
                  onClick={() => action(detail.client.id, { action: "repair_files" })}
                  className="px-3 py-1 border-[#00f0ff] text-[#00f0ff] rounded disabled:opacity-50 flex items-center gap-1">
                  <Wrench className="w-3.5 h-3.5" /> Repair files
                </button>
                <button disabled={busy}
                  title="Re-write .env and config.php with this site's real URL and database details. Use when the site 500s or shows an old domain."
                  onClick={() => action(detail.client.id, { action: "write_config" })}
                  className="px-3 py-1 border-emerald-500 text-emerald-400 rounded disabled:opacity-50 flex items-center gap-1">
                  <FileCog className="w-3.5 h-3.5" /> Write config (.env)
                </button>
              </div>
            </Panel>

            {/* re-run streams */}
            <Panel icon={<RefreshCw className="w-4 h-4 text-[#00f0ff]" />} title="RE-RUN SETUP (SAFE / RESUMABLE)">
              <div className="flex flex-wrap gap-2">
                <button disabled={streaming !== "" || busy} onClick={() => runStream("bootstrap")}
                  className="px-4 py-2 rounded border-[#00f0ff] text-[#00f0ff] font-bold disabled:opacity-50">
                  {streaming === "bootstrap" ? "Bootstrap running…" : "Re-run bootstrap"}
                </button>
                <button disabled={streaming !== "" || busy} onClick={() => runStream("install")}
                  className="px-4 py-2 rounded border-emerald-500 text-emerald-400 font-bold disabled:opacity-50">
                  {streaming === "install" ? "Setup running…" : "Re-run full setup (needs license key)"}
                </button>
              </div>
              {streaming !== "" && (
                <div className="space-y-2">
                  <div className="h-2 rounded-full bg-[#0a0d14] border-[#1e293b] overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-[#00f0ff] to-emerald-500 transition-all" style={{ width: `${streamProgress}%` }} />
                  </div>
                  <div className="text-slate-500 text-[11px]">{streamProgress}%</div>
                </div>
              )}
              {streamLog.length > 0 && (
                <div className="max-h-40 overflow-y-auto rounded bg-[#0a0d14] border-[#1e293b] p-3 text-[11px] text-slate-400 space-y-0.5">
                  {streamLog.map((l, i) => <div key={i}>{l}</div>)}
                </div>
              )}
            </Panel>

            {/* edit every stored field */}
            <Panel icon={<Pencil className="w-4 h-4 text-[#00f0ff]" />} title="EDIT ALL CLIENT DATA (MASTER)">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label="Contact name" value={edit.contactName} onChange={(v: string) => setEdit({ ...edit, contactName: v })} />
                <Field label="Contact email" value={edit.contactEmail} onChange={(v: string) => setEdit({ ...edit, contactEmail: v })} />
                <Field label="Contact phone" value={edit.contactPhone} onChange={(v: string) => setEdit({ ...edit, contactPhone: v })} />
                <Field label="Site URL" value={edit.siteUrl} onChange={(v: string) => setEdit({ ...edit, siteUrl: v })} />
                <Field label="File manager path" value={edit.fileManagerPath} onChange={(v: string) => setEdit({ ...edit, fileManagerPath: v })} />
                <Field label="cPanel host" value={edit.cpanelHost} onChange={(v: string) => setEdit({ ...edit, cpanelHost: v })} />
                <Field label="cPanel user" value={edit.cpanelUser} onChange={(v: string) => setEdit({ ...edit, cpanelUser: v })} />
                <Field label="New cPanel API token (blank = keep)" value={edit.cpanelApiToken} onChange={(v: string) => setEdit({ ...edit, cpanelApiToken: v })} />
                <div>
                  <label className="block text-slate-400 mb-1 uppercase">Package</label>
                  <select value={edit.package_id ?? ""} onChange={(e) => setEdit({ ...edit, package_id: e.target.value })}
                    className="w-full bg-[#0a0d14] border-[#1e293b] rounded px-3 py-2 text-white">
                    <option value="">— keep current —</option>
                    <PackageOptions />
                  </select>
                </div>
                <Select label="Billing cycle" value={edit.billing_cycle} onChange={(v: string) => setEdit({ ...edit, billing_cycle: v })}
                  options={CYCLES.map((c) => ({ value: c, label: c }))} />
                <Select label="Payment method" value={edit.payMethod} onChange={(v: string) => setEdit({ ...edit, payMethod: v })}
                  options={PAY_METHODS.map((c) => ({ value: c, label: c }))} />
                <Select label="Payment / order status" value={edit.status} onChange={(v: string) => setEdit({ ...edit, status: v })}
                  options={ORDER_STATUSES.map((c) => ({ value: c, label: c }))} />
                <Select label="License status" value={edit.license_status} onChange={(v: string) => setEdit({ ...edit, license_status: v })}
                  options={LICENSE_STATUSES.map((c) => ({ value: c, label: c }))} />
                <Field label="License expiry date" type="date" value={edit.license_expires_at || ""} onChange={(v: string) => setEdit({ ...edit, license_expires_at: v })} />
                <Field label="Activation limit" type="number" value={String(edit.activation_limit ?? "")} onChange={(v: string) => setEdit({ ...edit, activation_limit: Number(v) || 1 })} />
                <Select label="Remote access (pushed on save)" value={edit.remoteAccess} onChange={(v: string) => setEdit({ ...edit, remoteAccess: v })}
                  options={[{ value: "unknown", label: "— keep current —" }, { value: "full", label: "full" }, { value: "readonly", label: "readonly" }]} />
                <div className="md:col-span-2">
                  <label className="block text-slate-400 mb-1 uppercase">Notes</label>
                  <textarea value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} rows={2}
                    className="w-full bg-[#0a0d14] border-[#1e293b] rounded px-3 py-2 text-white" />
                </div>
              </div>
              <div className="flex flex-wrap gap-2 mt-1">
                <button disabled={busy} onClick={saveEdit} className="px-5 py-2 rounded bg-[#00f0ff] text-black font-bold disabled:opacity-50">{busy ? "Saving…" : "Save all changes"}</button>
                <button disabled={busy} onClick={() => removeClient(detail.client.id)} className="px-4 py-2 rounded border-rose-500 text-rose-400 font-bold disabled:opacity-50">Delete client</button>
                {detail.client.orderId && (
                  <a href={`/orders/${detail.client.orderId}`} target="_blank" rel="noreferrer" className="px-4 py-2 rounded border-[#1e293b] text-slate-300">Client order page</a>
                )}
              </div>
            </Panel>
          </div>
        </div>
      )}
    </FuturisticLayout>
  );
}

/* ── small UI atoms ─────────────── */

/**
 * License key row with a reveal toggle and a copy button.
 *
 * The raw key is fetched only when the operator asks for it (POST
 * reveal_key) and is never included in the client payload, so opening the drawer
 * does not spray the key into the page. If the license predates encrypted
 * storage the component offers a rotation instead of a dead end, because the key
 * genuinely cannot be recovered from a one-way hash.
 */
function LicenseKeyField({ clientId, last4 }: { clientId: string; last4: string | null }) {
  const [state, setState] = useState<{ loading: boolean; key: string | null; error: string; needsRotation: boolean }>({
    loading: false, key: null, error: "", needsRotation: false,
  });
  const [copied, setCopied] = useState(false);

  const mask = last4 ? `****-****-****-${last4}` : "not issued";
  const shown = state.key || mask;

  const reveal = async () => {
    if (state.key) { setState((s) => ({ ...s, key: null })); return; } // hide again
    setState({ loading: true, key: null, error: "", needsRotation: false });
    try {
      const d = await fetch(`/api/clients/${clientId}/actions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reveal_key" }),
      }).then((r) => r.json());
      if (!d.success) {
        setState({ loading: false, key: null, error: d.error || d.message || "Could not read the key.", needsRotation: Boolean(d.needsRotation) });
        return;
      }
      setState({ loading: false, key: d.key || null, error: "", needsRotation: false });
    } catch (e: any) {
      setState({ loading: false, key: null, error: e?.message || "Could not read the key.", needsRotation: false });
    }
  };

  const copy = async () => {
    if (!state.key) return;
    try {
      await navigator.clipboard.writeText(state.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked; the key is on screen to copy by hand.
      setState((s) => ({ ...s, error: "Your browser blocked the clipboard — select the key and copy it manually." }));
    }
  };

  return (
    <div className="flex gap-2 items-start md:col-span-2">
      <span className="text-slate-500 min-w-[150px] pt-1">License key</span>
      <div className="flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <code className={`flex-1 min-w-[200px] rounded border px-2 py-1 font-mono break-all ${state.key ? "border-[#00f0ff] text-[#00f0ff] bg-[#00f0ff]/5" : "border-[#1e293b] text-slate-200"}`}>
            {shown}
          </code>
          <button onClick={reveal} disabled={state.loading || !last4}
            title={state.key ? "Hide the key" : "Show the full key"}
            className="px-3 py-1 border-[#00f0ff] text-[#00f0ff] rounded flex items-center gap-1 disabled:opacity-40">
            {state.key ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            {state.loading ? "Reading…" : state.key ? "Hide" : "Show"}
          </button>
          <button onClick={copy} disabled={!state.key}
            title="Copy the full key"
            className="px-3 py-1 border-emerald-500 text-emerald-400 rounded flex items-center gap-1 disabled:opacity-40">
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        {state.error && (
          <div className="text-amber-400 text-[11px] flex flex-wrap items-center gap-2">
            <span>{state.error}</span>
            {state.needsRotation && (
              <button onClick={() => window.dispatchEvent(new CustomEvent("slate-rotate-key"))}
                className="px-2 py-0.5 border-[#00f0ff] text-[#00f0ff] rounded">Rotate key now</button>
            )}
          </div>
        )}
        {state.key && <div className="text-slate-500 text-[11px] break-all">Full key shown — copy it somewhere safe before closing.</div>}
      </div>
    </div>
  );
}

/**
 * Warn when Master has no public URL.
 *
 * The client's browser performs the activation handshake, so a loopback address
 * (the normal dev value) can never work: it resolves to the customer's own
 * machine. Surfacing it here means the operator fixes it BEFORE deploying rather
 * than debugging "Failed to fetch" from the customer's side.
 */
function MasterUrlBanner() {
  const [state, setState] = useState<{ ok: boolean; message: string; loopback: boolean; origin: string } | null>(null);

  useEffect(() => {
    fetch("/api/master/url", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setState(d))
      .catch(() => setState(null));
  }, []);

  if (!state || state.ok) return null;

  return (
    <div className="rounded-xl border border-amber-500/60 bg-amber-500/10 p-4 space-y-2">
      <div className="text-amber-300 font-bold flex items-center gap-2">
        <AlertTriangle className="w-4 h-4" /> Master has no public URL — client activation will fail
      </div>
      <div className="text-amber-200">{state.message}</div>
      <div className="text-slate-300 text-[11px]">
        Set <code className="text-[#00f0ff]">MASTER_PUBLIC_URL</code> in <code>.env.local</code> to the address
        your clients can reach (for example <code className="text-[#00f0ff]">https://master.yourdomain.com</code>),
        then restart Master. Already-deployed clients need <b>Repair files</b> to pick up the new address.
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border-[#1e293b] bg-[#0a0d14] p-3">
      <div className="text-slate-500 text-[10px] uppercase">{label}</div>
      <div className={`font-bold break-all ${tone || "text-slate-200"}`}>{value}</div>
    </div>
  );
}

function Panel({ icon, title, right, children }: { icon: React.ReactNode; title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border-[#1e293b] bg-[#111625] p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-slate-200 font-bold flex items-center gap-2">{icon} {title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return <div className="flex gap-2"><span className="text-slate-500 min-w-[150px]">{k}</span><span className="text-slate-200 break-all">{v}</span></div>;
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div>
      <label className="block text-slate-400 mb-1 uppercase">{label}</label>
      <input type={type} value={value ?? ""} onChange={(e) => onChange(e.target.value)}
        className="w-full bg-[#0a0d14] border-[#1e293b] rounded px-3 py-2 text-white" />
    </div>
  );
}

function Select({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }>;
}) {
  return (
    <div>
      <label className="block text-slate-400 mb-1 uppercase">{label}</label>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}
        className="w-full bg-[#0a0d14] border-[#1e293b] rounded px-3 py-2 text-white">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

/** Packages load lazily — the console only needs them when the drawer opens. */
function PackageOptions() {
  const [pkgs, setPkgs] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    fetch("/api/packages").then((r) => r.json()).then((d) => { if (d.success) setPkgs(d.packages); }).catch(() => {});
  }, []);
  return <>{pkgs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</>;
}
