"use client";
import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Shield, KeyRound, Server, Copy, Check,
  Activity, Package, CreditCard, Calendar, ExternalLink,
  LogOut, AlertCircle, Eye, EyeOff,
} from "lucide-react";

interface ClientLicense {
  id: string | null;
  status: string;
  effective: string;
  expiresAt: string | null;
  lifetime: boolean;
  daysLeft: number | null;
  expiringSoon: boolean;
  keyLast4: string | null;
  maskedKey: string | null;
  activationCount: number;
  activationLimit: number;
  billingCycle: string | null;
  lastSeenAt: string | null;
}

interface ClientDetail {
  id: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  siteUrl: string;
  fileManagerPath: string;
  packageName: string;
  packageSlug: string;
  pluginSet: string[];
  billingCycle: string;
  payMethod: string;
  paymentStatus: string;
  progressPercent: number;
  progressStage: string;
  siteStatus: string;
  latency: string;
  remoteAccess: string;
  coreVersion: string | null;
  agentVersion: string | null;
  activePlugins: string[];
  lastHealthAt: string | null;
  lastHealthStatus: string | null;
  license: ClientLicense;
  createdAt: string;
}

export default function ClientDashboardPage() {
  const router = useRouter();
  const [client, setClient] = useState<ClientDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const verifyRes = await fetch("/api/auth/verify?role=client");
      if (!verifyRes.ok) {
        router.replace("/client/login");
        return;
      }
      const session = await verifyRes.json();
      const clientId = session.clientId;
      if (!clientId) {
        router.replace("/client/login");
        return;
      }
      const detailRes = await fetch(`/api/clients/${clientId}?live=1`);
      const detail = await detailRes.json();
      if (!detail.success) {
        router.replace("/client/login");
        return;
      }
      setClient(detail.client);
      setLoading(false);
    })();
    }, [router]);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/client/login");
  };

  const handleCopyKey = async () => {
    if (!client?.license?.id) return;
    setActionLoading("reveal");
    try {
      const res = await fetch(`/api/clients/${client.id}?action=reveal-key`);
      const result = await res.json();
      if (result.key) {
        navigator.clipboard.writeText(result.key);
        setCopied(true);
        setTimeout(() => setCopied(false), 3000);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0d14] text-slate-100 flex items-center justify-center font-mono">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-[#00f0ff] border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
          <p className="text-slate-400">Loading your license dashboard…</p>
        </div>
      </div>
    );
  }

  if (!client) {
    return (
      <div className="min-h-screen bg-[#0a0d14] text-slate-100 flex items-center justify-center font-mono">
        <div className="text-center">
          <AlertCircle className="w-12 h-12 text-rose-400 mx-auto mb-3" />
          <p className="text-rose-300">Could not load client data.</p>
          <button
            onClick={() => router.replace("/client/login")}
            className="mt-4 px-4 py-2 text-sm rounded bg-[#00f0ff]/20 border border-[#00f0ff] text-[#00f0ff]"
          >
            Back to Login
                      </button>
        </div>
      </div>
    );
  }

  const c = client;
  const lic = c.license;

  const statusColors: Record<string, string> = {
    active: "text-emerald-400 border-emerald-500/50 bg-emerald-900/20",
    expired: "text-rose-400 border-rose-500/50 bg-rose-900/20",
    suspended: "text-amber-400 border-amber-500/50 bg-amber-900/20",
    revoked: "text-rose-400 border-rose-500/50 bg-rose-900/20",
    cancelled: "text-slate-400 border-slate-500/50 bg-slate-900/20",
    trial: "text-blue-400 border-blue-500/50 bg-blue-900/20",
    none: "text-slate-500 border-slate-600/50 bg-slate-900/20",
  };
  const statusClass = statusColors[lic.effective] || statusColors.none;
  const siteStatusClass =
    c.siteStatus === "ONLINE"
      ? "text-emerald-400"
      : c.siteStatus === "OFFLINE"
        ? "text-rose-400"
                : "text-amber-400";

  return (
    <div className="min-h-screen bg-[#0a0d14] text-slate-100 font-mono p-4 sm:p-6 overflow-hidden relative w-full">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 -left-1/2 w-96 h-96 bg-[#00f0ff]/3 rounded-full blur-3xl animate-pulse"></div>
        <div className="absolute bottom-0 -right-1/2 w-96 h-96 bg-cyan-500/3 rounded-full blur-3xl animate-pulse delay-1000"></div>
      </div>

      <div className="relative z-10 max-w-5xl mx-auto w-full">
        {/* Header */}
        <div className="flex justify-between items-center mb-8 pb-4 border-b border-[#1e293b]">
          <div>
            <h1 className="text-2xl font-extrabold text-white flex items-center gap-3">
              <Shield className="w-6 h-6 text-[#00f0ff]" />
              Your License Dashboard
            </h1>
            <p className="text-slate-400 text-sm mt-1">
              Welcome back, {c.contactName || c.contactEmail}
            </p>
          </div>
          <button
            onClick={handleLogout}
            className="px-4 py-2 text-xs rounded-lg bg-rose-900/30 border border-rose-500/50 text-rose-300 hover:bg-rose-900/50 transition-colors flex items-center gap-2"
          >
            <LogOut className="w-4 h-4" />
                        Sign Out
          </button>
        </div>

        {/* Key | Status | Package cards */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-8">
          <div className="bg-[#111625]/60 border border-[#1e293b] rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs text-slate-400 uppercase">License Key</h3>
              <KeyRound className="w-4 h-4 text-slate-500" />
            </div>
            <div className="flex items-center gap-2 mb-3">
              <code className="text-base sm:text-lg font-mono text-white tracking-widest truncate">
                {lic.maskedKey || "—"}
              </code>
              <button onClick={() => setShowKey(!showKey)} className="p-1 rounded hover:bg-[#1e293b] transition-colors">
                {showKey ? <Eye className="w-4 h-4 text-slate-500" /> : <EyeOff className="w-4 h-4 text-slate-500" />}
              </button>
            </div>
            {lic.keyLast4 && (
              <button onClick={handleCopyKey} disabled={actionLoading === "reveal"}
                className="w-full py-2 text-xs rounded bg-[#00f0ff]/10 border border-[#00f0ff]/30 text-[#00f0ff] hover:bg-[#00f0ff]/20 flex items-center justify-center gap-2">
                {actionLoading === "reveal" ? <div className="w-3 h-3 border border-[#00f0ff] border-t-transparent rounded-full animate-spin"></div> : copied ? <Check className="w-4 h-4" /> : <><Copy className="w-4 h-4" /> Reveal full key</>}
              </button>
            )}
          </div>

          <div className="bg-[#111625]/60 border border-[#1e293b] rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs text-slate-400 uppercase">License Status</h3>
              <Activity className="w-4 h-4 text-slate-500" />
            </div>
            <div className={`inline-block px-3 py-1 rounded-lg border text-sm font-bold ${statusClass}`}>
              {(lic.status || "none").toUpperCase()}
            </div>
            {lic.expiresAt && !lic.lifetime && (
              <div className="mt-3">
                <p className="text-xs text-slate-500">Expires</p>
                <p className="text-sm text-white flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-slate-400" />
                  {new Date(lic.expiresAt).toLocaleString()}
                </p>
                {lic.daysLeft !== null && (
                  <p className={`text-xs mt-1 ${lic.daysLeft < 0 ? "text-rose-400" : lic.daysLeft < 30 ? "text-amber-400" : "text-emerald-400"}`}>
                    {lic.daysLeft < 0 ? `${Math.abs(lic.daysLeft)} days expired` : `${lic.daysLeft} days remaining`}
                  </p>
                )}
              </div>
            )}
            {lic.lifetime && <p className="text-xs text-emerald-400 mt-2">✓ Lifetime license</p>}
          </div>

          <div className="bg-[#111625]/60 border border-[#1e293b] rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs text-slate-400 uppercase">Active Package</h3>
              <Package className="w-4 h-4 text-slate-500" />
            </div>
            <p className="text-lg font-bold text-white">{c.packageName}</p>
            <p className="text-slate-400 text-sm mt-1">/{c.packageSlug}</p>
            {c.pluginSet?.length > 0 && (
              <div className="mt-3">
                <p className="text-xs text-slate-500 mb-1.5">Included Plugins</p>
                <div className="flex flex-wrap gap-1.5">
                  {c.pluginSet.map((plugin: string) => (
                    <span key={plugin} className="px-2 py-1 bg-[#0a0d14] border border-[#1e293b] rounded text-xs text-slate-300">
                      {plugin}
                    </span>
                  ))}
                </div>
              </div>
            )}
                    </div>
        </div>

        {/* Payment & Site Health */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-8">
          <div className="bg-[#111625]/60 border border-[#1e293b] rounded-xl p-5">
            <h3 className="text-xs text-slate-400 uppercase mb-3 flex items-center gap-2">
              <CreditCard className="w-4 h-4" /> Payment Details
            </h3>
            <div className="space-y-2.5 text-sm">
              <div className="flex justify-between gap-3"><span className="text-slate-400 shrink-0">Billing Cycle</span><span className="text-white capitalize text-right">{c.billingCycle}</span></div>
              <div className="flex justify-between gap-3"><span className="text-slate-400 shrink-0">Payment Method</span><span className="text-white capitalize text-right">{c.payMethod.replace(/_/g, " ")}</span></div>
              <div className="flex justify-between gap-3"><span className="text-slate-400 shrink-0">Payment Status</span>
                <span className={`font-bold ${c.paymentStatus === "paid" || c.paymentStatus === "completed" ? "text-emerald-400" : c.paymentStatus === "pending_payment" ? "text-amber-400" : "text-rose-400"}`}>
                  {c.paymentStatus.replace(/_/g, " ")}
                </span>
              </div>
            </div>
          </div>

          <div className="bg-[#111625]/60 border border-[#1e293b] rounded-xl p-5">
            <h3 className="text-xs text-slate-400 uppercase mb-3 flex items-center gap-2">
              <Server className="w-4 h-4" /> Live Site Status
            </h3>
            <div className="space-y-2.5 text-sm">
              <div className="flex justify-between items-center gap-3">
                <span className="text-slate-400 shrink-0">Site URL</span>
                <a href={c.siteUrl} target="_blank" rel="noopener noreferrer" className="text-[#00f0ff] hover:underline flex items-center gap-1 min-w-0 text-right">
                  <span className="truncate">{c.siteUrl}</span> <ExternalLink className="w-3 h-3 shrink-0" />
                </a>
              </div>
              <div className="flex justify-between gap-3"><span className="text-slate-400 shrink-0">Status</span><span className={`font-bold ${siteStatusClass}`}>{c.siteStatus}</span></div>
              {c.latency && (<div className="flex justify-between gap-3"><span className="text-slate-400 shrink-0">Latency</span><span className="text-white">{c.latency}</span></div>)}
              {c.lastHealthAt && (<div className="flex justify-between gap-3"><span className="text-slate-400 shrink-0">Last Health Check</span><span className="text-slate-300 text-xs text-right">{new Date(c.lastHealthAt).toLocaleString()}</span></div>)}
            </div>
          </div>
        </div>

        {/* Environment Details */}
        <div className="bg-[#111625]/60 border border-[#1e293b] rounded-xl p-5 mb-8">
          <h3 className="text-xs text-slate-400 uppercase mb-3">Environment Details</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            {c.coreVersion && (<div className="flex justify-between gap-3"><span className="text-slate-400 shrink-0">Slate Core Version</span><span className="text-white text-right min-w-0">{c.coreVersion}</span></div>)}
            {c.agentVersion && (<div className="flex justify-between gap-3"><span className="text-slate-400 shrink-0">Agent Version</span><span className="text-white text-right min-w-0">{c.agentVersion}</span></div>)}
            <div className="flex justify-between gap-3"><span className="text-slate-400 shrink-0">File Path</span><span className="text-slate-300 text-xs text-right min-w-0">{c.fileManagerPath || "—"}</span></div>
            <div className="flex justify-between gap-3"><span className="text-slate-400 shrink-0">Registered</span><span className="text-slate-300 text-xs">{new Date(c.createdAt).toLocaleDateString()}</span></div>
          </div>
          {c.activePlugins?.length > 0 && (
            <div className="mt-3">
              <p className="text-xs text-slate-500 mb-1.5">Active Plugins</p>
              <div className="flex flex-wrap gap-1.5">
                {c.activePlugins.map((plugin: string) => (
                  <span key={plugin} className="px-2 py-1 bg-[#0a0d14] border border-[#1e293b] rounded text-xs text-slate-300">{plugin}</span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="text-center pb-8">
          <p className="text-xs text-slate-500">
            Need to update your contact information? Contact your system administrator.
          </p>
        </div>
      </div>
    </div>
  );
}
