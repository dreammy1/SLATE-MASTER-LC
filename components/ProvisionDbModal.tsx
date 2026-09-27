"use client";

import React, { useState } from "react";
import { Database, X, Loader2, CheckCircle2 } from "lucide-react";

interface ProvisionDbModalProps {
  isOpen: boolean;
  onClose: () => void;
  onProvisioned: (newDb: any) => void;
  sites: Array<{ id: string; domain: string }>;
}

export default function ProvisionDbModal({ isOpen, onClose, onProvisioned, sites }: ProvisionDbModalProps) {
  const [mode, setMode] = useState<"mysql" | "cpanel">("mysql");
  const [targetDbName, setTargetDbName] = useState("");
  const [targetDbUser, setTargetDbUser] = useState("");
  const [targetDbPass, setTargetDbPass] = useState("");
  const [linkedSiteId, setLinkedSiteId] = useState("");

  // Direct MySQL fields
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("3306");
  const [adminUser, setAdminUser] = useState("root");
  const [adminPass, setAdminPass] = useState("");

  // cPanel fields
  const [cpanelHost, setCpanelHost] = useState("");
  const [cpanelUser, setCpanelUser] = useState("");
  const [apiToken, setApiToken] = useState("");

  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setNotice("");

    try {
      const payload: any = {
        mode,
        targetDbName,
        targetDbUser: targetDbUser || `${targetDbName}_usr`,
        targetDbPass: targetDbPass || "Pass_2026_Secure!",
        linkedSiteId: linkedSiteId || null,
      };

      if (mode === "mysql") {
        payload.host = host;
        payload.port = port;
        payload.adminUser = adminUser;
        payload.adminPass = adminPass;
      } else {
        payload.cpanelHost = cpanelHost;
        payload.cpanelUser = cpanelUser;
        payload.apiToken = apiToken;
      }

      const res = await fetch("/api/databases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Provisioning failed");

      setNotice(data.message || "Database provisioned and stored successfully!");
      setTimeout(() => {
        onProvisioned(data.database);
        onClose();
      }, 1000);
    } catch (err: any) {
      alert("Error provisioning database: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="glass-panel w-full max-w-lg rounded-xl p-6 border border-[#7000ff]/50 space-y-5 font-mono text-xs shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#1e293b] pb-3">
          <div className="flex items-center gap-2 text-[#7000ff]">
            <Database className="w-5 h-5" />
            <h2 className="font-bold text-sm text-white uppercase">Provision Database Instance</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode Selector */}
        <div className="flex rounded-lg bg-[#0a0d14] p-1 border border-[#1e293b]">
          <button
            type="button"
            onClick={() => setMode("mysql")}
            className={`flex-1 py-1.5 rounded text-xs font-bold transition-all ${
              mode === "mysql"
                ? "bg-[#7000ff] text-white shadow-[0_0_10px_rgba(112,0,255,0.4)]"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Direct MySQL / MariaDB
          </button>
          <button
            type="button"
            onClick={() => setMode("cpanel")}
            className={`flex-1 py-1.5 rounded text-xs font-bold transition-all ${
              mode === "cpanel"
                ? "bg-[#7000ff] text-white shadow-[0_0_10px_rgba(112,0,255,0.4)]"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            cPanel UAPI
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-300 mb-1">TARGET DB NAME</label>
              <input
                type="text"
                required
                value={targetDbName}
                onChange={(e) => setTargetDbName(e.target.value)}
                placeholder="app_production_db"
                className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white focus:outline-none focus:border-[#7000ff]"
              />
            </div>
            <div>
              <label className="block text-slate-300 mb-1">TARGET DB USER</label>
              <input
                type="text"
                value={targetDbUser}
                onChange={(e) => setTargetDbUser(e.target.value)}
                placeholder="db_user (optional)"
                className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white focus:outline-none focus:border-[#7000ff]"
              />
            </div>
          </div>

          <div>
            <label className="block text-slate-300 mb-1">TARGET DB PASSWORD</label>
            <input
              type="password"
              value={targetDbPass}
              onChange={(e) => setTargetDbPass(e.target.value)}
              placeholder="Leave blank for auto-generated secure key"
              className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white focus:outline-none focus:border-[#7000ff]"
            />
          </div>

          <div>
            <label className="block text-slate-300 mb-1">LINK TO TARGET SITE (OPTIONAL)</label>
            <select
              value={linkedSiteId}
              onChange={(e) => setLinkedSiteId(e.target.value)}
              className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white focus:outline-none focus:border-[#7000ff]"
            >
              <option value="">-- No Linked Site --</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.domain}
                </option>
              ))}
            </select>
          </div>

          {mode === "mysql" ? (
            <div className="p-3 bg-[#0a0d14]/80 rounded border border-[#1e293b] space-y-3">
              <div className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                Direct Host Credentials
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">HOST / IP</label>
                  <input
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    className="w-full bg-[#111625] border border-[#1e293b] rounded px-2.5 py-1.5 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">PORT</label>
                  <input
                    type="number"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    className="w-full bg-[#111625] border border-[#1e293b] rounded px-2.5 py-1.5 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">ADMIN USER</label>
                  <input
                    type="text"
                    value={adminUser}
                    onChange={(e) => setAdminUser(e.target.value)}
                    className="w-full bg-[#111625] border border-[#1e293b] rounded px-2.5 py-1.5 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">ADMIN PASSWORD</label>
                  <input
                    type="password"
                    value={adminPass}
                    onChange={(e) => setAdminPass(e.target.value)}
                    placeholder="••••••••"
                    className="w-full bg-[#111625] border border-[#1e293b] rounded px-2.5 py-1.5 text-white"
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="p-3 bg-[#0a0d14]/80 rounded border border-[#1e293b] space-y-3">
              <div className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                cPanel Server & API Token
              </div>
              <div>
                <label className="block text-slate-400 mb-1">CPANEL HOSTNAME</label>
                <input
                  type="text"
                  value={cpanelHost}
                  onChange={(e) => setCpanelHost(e.target.value)}
                  placeholder="cpanel.clienthost.com"
                  className="w-full bg-[#111625] border border-[#1e293b] rounded px-2.5 py-1.5 text-white"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">CPANEL USER</label>
                  <input
                    type="text"
                    value={cpanelUser}
                    onChange={(e) => setCpanelUser(e.target.value)}
                    placeholder="username"
                    className="w-full bg-[#111625] border border-[#1e293b] rounded px-2.5 py-1.5 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">API TOKEN</label>
                  <input
                    type="password"
                    value={apiToken}
                    onChange={(e) => setApiToken(e.target.value)}
                    placeholder="API Token..."
                    className="w-full bg-[#111625] border border-[#1e293b] rounded px-2.5 py-1.5 text-white"
                  />
                </div>
              </div>
            </div>
          )}

          {notice && (
            <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded text-emerald-400 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{notice}</span>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-3 border-t border-[#1e293b]">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded bg-[#111625] hover:bg-[#171f33] border border-[#1e293b] text-slate-300"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !targetDbName}
              className="px-5 py-2 rounded bg-[#7000ff]/20 border border-[#7000ff] text-[#7000ff] hover:bg-[#7000ff] hover:text-white transition-all font-bold shadow-[0_0_15px_rgba(112,0,255,0.25)] flex items-center gap-2 disabled:opacity-50"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Database className="w-4 h-4" />}
              Provision & Save Instance
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
