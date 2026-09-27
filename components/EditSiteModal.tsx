"use client";

import React, { useState, useEffect } from "react";
import { 
  Server, 
  X, 
  Loader2, 
  Download, 
  Copy, 
  Check, 
  RefreshCw, 
  Shield, 
  CheckCircle2, 
  Radio, 
  ExternalLink 
} from "lucide-react";
import { Site } from "@/lib/storage";

interface EditSiteModalProps {
  isOpen: boolean;
  site: Site | null;
  onClose: () => void;
  onUpdated: (updatedSite: Site) => void;
}

export default function EditSiteModal({ isOpen, site, onClose, onUpdated }: EditSiteModalProps) {
  const [domain, setDomain] = useState("");
  const [path, setPath] = useState("");
  const [framework, setFramework] = useState("");
  const [repo, setRepo] = useState("");
  const [handshakeToken, setHandshakeToken] = useState("");
  
  const [loading, setLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "error" | "info"; text: string } | null>(null);

  useEffect(() => {
    if (site) {
      setDomain(site.domain);
      setPath(site.path);
      setFramework(site.framework);
      setRepo(site.repo);
      setHandshakeToken(site.handshakeToken);
      setNotice(null);
    }
  }, [site]);

  if (!isOpen || !site) return null;

  // Save standard details
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setNotice(null);

    try {
      const res = await fetch(`/api/sites/${site.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain,
          path,
          framework,
          repo,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Update failed");

      onUpdated(data.site);
      setNotice({ type: "success", text: "Target environment settings saved." });
      setTimeout(() => {
        onClose();
      }, 700);
    } catch (err: any) {
      setNotice({ type: "error", text: err.message });
    } finally {
      setLoading(false);
    }
  };

  // Copy token to clipboard
  const handleCopyToken = () => {
    if (!handshakeToken) return;
    navigator.clipboard.writeText(handshakeToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Regenerate handshake token
  const handleRegenerateToken = async () => {
    if (!confirm("Regenerate handshake token? You will need to upload the new auth.php or pair your live server agent.")) {
      return;
    }

    setRegenerating(true);
    setNotice(null);

    try {
      const res = await fetch(`/api/sites/${site.id}/regenerate-token`, {
        method: "POST",
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to regenerate token");
      }

      setHandshakeToken(data.handshakeToken);
      if (data.site) {
        onUpdated(data.site);
      }

      setNotice({
        type: "success",
        text: data.remoteSynced
          ? "New handshake token generated & synced with live agent!"
          : "New token generated! Click 'Download auth.php' and upload to your server.",
      });
    } catch (err: any) {
      setNotice({ type: "error", text: err.message });
    } finally {
      setRegenerating(false);
    }
  };

  // Verify handshake on live server
  const handleVerifyHandshake = async () => {
    setVerifying(true);
    setNotice(null);

    try {
      const res = await fetch(`/api/sites/${site.id}/handshake`, {
        method: "POST",
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Handshake verification failed");
      }

      setNotice({
        type: "success",
        text: `Handshake active! Remote agent responded with status: ${data.status}`,
      });
    } catch (err: any) {
      setNotice({
        type: "error",
        text: `Handshake check failed: ${err.message}. Make sure auth.php is uploaded to ${path}.`,
      });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="glass-panel w-full max-w-xl rounded-xl p-6 border border-[#00f0ff]/40 space-y-5 font-mono text-xs shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-[#1e293b] pb-3">
          <div className="flex items-center gap-2 text-[#00f0ff]">
            <Server className="w-5 h-5" />
            <h2 className="font-bold text-sm text-white uppercase">Target Environment Configuration</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {notice && (
          <div
            className={`p-3 rounded-lg border font-mono text-xs flex items-center gap-2 ${
              notice.type === "success"
                ? "bg-emerald-500/15 border-emerald-500 text-emerald-300"
                : notice.type === "error"
                ? "bg-rose-500/15 border-rose-500 text-rose-300"
                : "bg-blue-500/15 border-blue-500 text-blue-300"
            }`}
          >
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{notice.text}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-slate-300 mb-1">TARGET DOMAIN</label>
            <input
              type="text"
              required
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
              value={path}
              onChange={(e) => setPath(e.target.value)}
              className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white focus:outline-none focus:border-[#00f0ff]"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-300 mb-1">FRAMEWORK / TYPE</label>
              <select
                value={framework}
                onChange={(e) => setFramework(e.target.value)}
                className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white focus:outline-none focus:border-[#00f0ff]"
              >
                <option value="WordPress">WordPress</option>
                <option value="Laravel">Laravel</option>
                <option value="React / Node">React / Node</option>
                <option value="Vanilla PHP">Vanilla PHP</option>
                <option value="Custom HTML/JS">Custom HTML/JS</option>
              </select>
            </div>
            <div>
              <label className="block text-slate-300 mb-1">LINKED GITHUB REPOSITORY</label>
              <input
                type="text"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white focus:outline-none focus:border-[#00f0ff]"
              />
            </div>
          </div>

          {/* ═════════════════════════════════════════════════════════════════ */}
          {/* REMOTE AGENT (auth.php) & HANDSHAKE MANAGEMENT                   */}
          {/* ═════════════════════════════════════════════════════════════════ */}
          <div className="rounded-xl border border-[#7000ff]/40 p-4 bg-[#0a0d19]/90 space-y-3 mt-4">
            <div className="flex items-center justify-between border-b border-[#1e293b] pb-2">
              <div className="flex items-center gap-2 text-white font-bold text-xs">
                <Shield className="w-4 h-4 text-[#7000ff]" />
                REMOTE DEPLOYMENT AGENT (auth.php v3.0.0)
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded bg-[#7000ff]/20 text-[#a855f7] border border-[#7000ff]/40">
                cPanel & MySQL Ready
              </span>
            </div>

            {/* Handshake Token row with Copy & Regenerate */}
            <div>
              <div className="flex items-center justify-between text-slate-400 text-[11px] mb-1">
                <span>HANDSHAKE AUTH TOKEN</span>
                <span className="text-slate-500 text-[10px]">Pairs Master OS ↔ Remote Agent</span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={handshakeToken}
                  className="flex-1 bg-[#05070d] border border-[#1e293b] rounded px-3 py-2 text-[#00f0ff] font-mono text-xs select-all focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleCopyToken}
                  className="px-3 py-2 rounded bg-[#111625] hover:bg-[#171f33] border border-[#1e293b] text-slate-300 hover:text-white flex items-center gap-1 transition-colors shrink-0"
                  title="Copy Handshake Token"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied ? "Copied" : "Copy"}</span>
                </button>
                <button
                  type="button"
                  disabled={regenerating}
                  onClick={handleRegenerateToken}
                  className="px-3 py-2 rounded bg-[#7000ff]/20 hover:bg-[#7000ff] border border-[#7000ff] text-[#a855f7] hover:text-white flex items-center gap-1.5 transition-all shadow-[0_0_10px_rgba(112,0,255,0.2)] disabled:opacity-50 shrink-0 font-bold"
                  title="Generate a new secure handshake key"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${regenerating ? "animate-spin" : ""}`} />
                  <span>{regenerating ? "Generating..." : "Regenerate Key"}</span>
                </button>
              </div>
            </div>

            {/* Action Buttons: Download auth.php & Verify Handshake */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 pt-2 border-t border-[#1e293b]">
              <div className="text-[11px] text-slate-400">
                Target Path: <code className="text-[#00f0ff]">{path}/auth.php</code>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={verifying}
                  onClick={handleVerifyHandshake}
                  className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white transition-colors flex items-center gap-1.5 text-xs font-mono"
                  title="Test if remote auth.php is responding to handshake"
                >
                  <Radio className={`w-3.5 h-3.5 text-[#00f0ff] ${verifying ? "animate-pulse" : ""}`} />
                  <span>{verifying ? "Testing..." : "Verify Handshake"}</span>
                </button>
                <a
                  href={`/api/sites/${site.id}/download-agent`}
                  download="auth.php"
                  className="px-4 py-1.5 rounded bg-[#00f0ff]/20 hover:bg-[#00f0ff] border border-[#00f0ff] text-[#00f0ff] hover:text-black font-bold flex items-center justify-center gap-1.5 transition-all shadow-[0_0_15px_rgba(0,240,255,0.25)] text-xs font-mono shrink-0"
                  title="Download latest auth.php with pre-configured headers"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download auth.php</span>
                </a>
              </div>
            </div>
          </div>

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
              disabled={loading}
              className="px-5 py-2 rounded bg-[#00f0ff]/20 border border-[#00f0ff] text-[#00f0ff] hover:bg-[#00f0ff] hover:text-black transition-all font-bold shadow-[0_0_15px_rgba(0,240,255,0.25)] flex items-center gap-2 disabled:opacity-50"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              Save Changes
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

