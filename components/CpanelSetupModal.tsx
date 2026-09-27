"use client";

import { useState } from "react";

interface CpanelSetupModalProps {
  siteId: string;
  siteDomain: string;
  onClose: () => void;
  onSuccess: (cpanelUser: string) => void;
}

export default function CpanelSetupModal({
  siteId,
  siteDomain,
  onClose,
  onSuccess,
}: CpanelSetupModalProps) {
  const [cpanelUser, setCpanelUser] = useState("");
  const [cpanelToken, setCpanelToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setWarning(null);

    try {
      const res = await fetch(`/api/sites/${siteId}/database`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "setup_cpanel",
          cpanel_user: cpanelUser.trim(),
          cpanel_api_token: cpanelToken.trim(),
        }),
      });

      const data = await res.json();
      if (!data.success) {
        setError(data.error || "Setup failed.");
        return;
      }

      if (data.agentResponse?.warning) {
        setWarning(data.agentResponse.warning);
        // Still call onSuccess — credentials were saved
        setTimeout(() => onSuccess(cpanelUser.trim()), 2000);
      } else {
        onSuccess(cpanelUser.trim());
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(6px)" }}>
      <div
        className="relative w-full max-w-md rounded-2xl p-6 shadow-2xl"
        style={{
          background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
          border: "1px solid rgba(139,92,246,0.3)",
        }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center text-xl"
            style={{ background: "linear-gradient(135deg, #7c3aed, #4f46e5)" }}
          >
            🔗
          </div>
          <div>
            <h2 className="text-white font-bold text-lg">Link cPanel Account</h2>
            <p className="text-slate-400 text-sm">{siteDomain}</p>
          </div>
          <button
            onClick={onClose}
            className="ml-auto text-slate-400 hover:text-white transition-colors text-xl"
            disabled={loading}
          >
            ✕
          </button>
        </div>

        {/* Info box */}
        <div
          className="rounded-xl p-4 mb-5 text-sm"
          style={{ background: "rgba(99,102,241,0.1)", border: "1px solid rgba(99,102,241,0.25)" }}
        >
          <p className="text-indigo-300 font-semibold mb-1">🔑 How to get your API Token</p>
          <ol className="text-slate-300 space-y-1 list-decimal list-inside">
            <li>Log in to cPanel</li>
            <li>Go to <strong>Security → Manage API Tokens</strong></li>
            <li>Click <strong>Create Token</strong>, give it any name</li>
            <li>Copy the generated token and paste below</li>
          </ol>
          <p className="text-slate-400 mt-2 text-xs">
            ✅ Token is stored encrypted on your server only — never sent to GitHub.
          </p>
        </div>

        {error && (
          <div
            className="rounded-xl p-3 mb-4 text-sm text-red-300"
            style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)" }}
          >
            ⚠️ {error}
          </div>
        )}

        {warning && (
          <div
            className="rounded-xl p-3 mb-4 text-sm text-yellow-300"
            style={{ background: "rgba(234,179,8,0.1)", border: "1px solid rgba(234,179,8,0.3)" }}
          >
            ⚠️ {warning}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-slate-300 text-sm font-medium block mb-1">cPanel Username</label>
            <input
              type="text"
              placeholder="e.g. whateve1"
              value={cpanelUser}
              onChange={(e) => setCpanelUser(e.target.value)}
              required
              className="w-full px-4 py-3 rounded-xl text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }}
            />
          </div>

          <div>
            <label className="text-slate-300 text-sm font-medium block mb-1">cPanel API Token</label>
            <input
              type="password"
              placeholder="Paste your API token here"
              value={cpanelToken}
              onChange={(e) => setCpanelToken(e.target.value)}
              required
              className="w-full px-4 py-3 rounded-xl text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }}
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex-1 py-3 rounded-xl text-slate-300 text-sm font-medium transition-all"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !cpanelUser || !cpanelToken}
              className="flex-1 py-3 rounded-xl text-white text-sm font-bold transition-all disabled:opacity-50"
              style={{ background: "linear-gradient(135deg, #7c3aed, #4f46e5)" }}
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Verifying…
                </span>
              ) : (
                "🔗 Link cPanel"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
