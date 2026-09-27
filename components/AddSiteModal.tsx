"use client";

import React, { useState } from "react";
import { Server, Download, Check, Copy, X, Loader2 } from "lucide-react";
import { Site } from "@/lib/storage";

export default function AddSiteModal({
  isOpen,
  onClose,
  onAdded,
}: {
  isOpen: boolean;
  onClose: () => void;
  onAdded?: (site: Site) => void;
}) {
  const [domain, setDomain] = useState("");
  const [deployPath, setDeployPath] = useState("/public_html");
  const [appType, setAppType] = useState("WordPress");
  const [generatedToken, setGeneratedToken] = useState("");
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const res = await fetch("/api/sites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain,
          path: deployPath,
          framework: appType,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to register site");

      setGeneratedToken(data.site.handshakeToken);
      if (onAdded) {
        onAdded(data.site);
      }
    } catch (err: any) {
      alert("Error creating site: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  const copyToken = () => {
    navigator.clipboard.writeText(generatedToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleClose = () => {
    setGeneratedToken("");
    setDomain("");
    setDeployPath("/public_html");
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="glass-panel w-full max-w-lg rounded-xl p-6 border border-[#00f0ff]/40 space-y-5 font-mono text-xs shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#1e293b] pb-3">
          <div className="flex items-center gap-2 text-[#00f0ff]">
            <Server className="w-5 h-5" />
            <h2 className="font-bold text-sm text-white uppercase">Register New Target Domain</h2>
          </div>
          <button onClick={handleClose} className="text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {!generatedToken ? (
          <form onSubmit={handleGenerate} className="space-y-4">
            <div>
              <label className="block text-slate-300 mb-1">TARGET DOMAIN URL</label>
              <input
                type="text"
                required
                placeholder="https://app.clientdomain.com"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white focus:outline-none focus:border-[#00f0ff]"
              />
            </div>
            <div>
              <label className="block text-slate-300 mb-1">REMOTE DIRECTORY PATH</label>
              <input
                type="text"
                required
                value={deployPath}
                onChange={(e) => setDeployPath(e.target.value)}
                className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white focus:outline-none focus:border-[#00f0ff]"
              />
            </div>
            <div>
              <label className="block text-slate-300 mb-1">APPLICATION TYPE</label>
              <select
                value={appType}
                onChange={(e) => setAppType(e.target.value)}
                className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white focus:outline-none focus:border-[#00f0ff]"
              >
                <option value="WordPress">WordPress (Bedrock / Standard)</option>
                <option value="Laravel">Laravel / Symfony</option>
                <option value="React / Node">React / Next.js SPA</option>
                <option value="Vanilla PHP">Standard PHP App</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded bg-[#00f0ff]/20 border border-[#00f0ff] text-[#00f0ff] font-bold hover:bg-[#00f0ff] hover:text-black transition-colors shadow-[0_0_15px_rgba(0,240,255,0.25)] flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Server className="w-4 h-4" />}
              Generate auth.php Agent & Handshake Key
            </button>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded text-emerald-400">
              Target configuration saved & persisted! Complete the setup with steps below:
            </div>

            <div className="space-y-2">
              <label className="text-slate-400">1. DOWNLOAD AGENT SCRIPT</label>
              <a
                href="/auth.php"
                download="auth.php"
                className="flex items-center justify-center gap-2 py-2 px-4 bg-[#111625] border border-[#1e293b] hover:border-[#00f0ff] rounded text-slate-200 transition-colors"
              >
                <Download className="w-4 h-4 text-[#00f0ff]" /> Download auth.php (Upload to {deployPath})
              </a>
            </div>

            <div className="space-y-2">
              <label className="text-slate-400">2. SECURE HANDSHAKE KEY</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={generatedToken}
                  className="flex-1 bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-[#00f0ff] select-all"
                />
                <button
                  onClick={copyToken}
                  className="p-2 rounded bg-[#111625] border border-[#1e293b] hover:border-[#00f0ff] text-slate-200"
                >
                  {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4 text-slate-400" />}
                </button>
              </div>
            </div>

            <button
              onClick={handleClose}
              className="w-full py-2 rounded bg-slate-800 hover:bg-slate-700 text-white font-bold transition-colors"
            >
              Done / Return to Dashboard
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
