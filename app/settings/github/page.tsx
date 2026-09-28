"use client";

import React, { useState, useEffect, Suspense } from "react";
import FuturisticLayout from "@/components/FuturisticLayout";
import { GitBranch, Key, CheckCircle2, ShieldCheck, RefreshCw, Link as LinkIcon, User, Lock } from "lucide-react";
import { Site } from "@/lib/storage";

function GitHubSettingsContent() {
  const [token, setToken] = useState("");
  const [maskedToken, setMaskedToken] = useState("");
  const [username, setUsername] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [scopesValid, setScopesValid] = useState<boolean | null>(null);

  const [sites, setSites] = useState<Site[]>([]);
  const [selectedDomain, setSelectedDomain] = useState("");
  const [selectedRepo, setSelectedRepo] = useState("");
  const [customRepo, setCustomRepo] = useState("");
  const [rebinding, setRebinding] = useState(false);
  const [notice, setNotice] = useState("");

  // Load saved credentials and sites on mount
  useEffect(() => {
    fetch("/api/settings/github")
      .then((r) => r.json())
      .then((data) => {
        if (data.success && data.hasToken) {
          setMaskedToken(data.maskedToken);
          setUsername(data.username);
          setAvatarUrl(data.avatarUrl);
          setScopesValid(true);
        }
      })
      .catch(() => {});

    fetch("/api/sites")
      .then((r) => r.json())
      .then((data) => {
        if (data.success && Array.isArray(data.sites)) {
          setSites(data.sites);
        }
      })
      .catch(() => {});
  }, []);

  const handleVerifyAndSaveToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setVerifying(true);

    try {
      const res = await fetch("/api/settings/github", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save token");

      setScopesValid(true);
      setUsername(data.user.login);
      setAvatarUrl(data.user.avatar_url);
      setMaskedToken(token.substring(0, 4) + "••••••••••••••••" + token.substring(token.length - 4));
      setToken("");
      setNotice(`GitHub Personal Access Token encrypted with AES-256 and verified for @${data.user.login}.`);
    } catch (err: any) {
      alert("Error: " + err.message);
    } finally {
      setVerifying(false);
    }
  };

  const handleRebind = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalRepo = customRepo.trim() || selectedRepo;
    if (!selectedDomain || !finalRepo) return;

    setRebinding(true);
    try {
      const res = await fetch("/api/settings/rebind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: selectedDomain,
          repo: finalRepo,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Rebind failed");

      setNotice(`Successfully re-bound '${finalRepo}' to '${selectedDomain}'. Webhook secret and CI/CD parameters synchronized.`);
      // Refresh sites list
      const sitesRes = await fetch("/api/sites");
      const sitesData = await sitesRes.json();
      if (sitesData.success) setSites(sitesData.sites);
    } catch (err: any) {
      alert("Error re-binding repository: " + err.message);
    } finally {
      setRebinding(false);
    }
  };

  return (
    <FuturisticLayout>
      <div className="max-w-4xl space-y-6 font-mono text-xs w-full min-w-0">
        {notice && (
          <div className="p-3 bg-[#00f0ff]/15 border border-[#00f0ff] text-[#00f0ff] rounded-lg font-mono text-xs flex items-center gap-2 shadow-[0_0_15px_rgba(0,240,255,0.25)] animate-in fade-in">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{notice}</span>
          </div>
        )}

        <div>
          <h2 className="text-xl font-bold text-white tracking-wider flex items-center gap-2">
            <GitBranch className="w-5 h-5 text-[#00f0ff]" />
            GITHUB ACCOUNT & REPOSITORY SETTINGS
          </h2>
          <p className="text-slate-400">
            Configure dynamic GitHub authentication, verify scopes, and re-bind repositories to remote paths with persistent storage.
          </p>
        </div>

        {/* Credentials & Token Scope Check */}
        <div className="glass-panel rounded-xl p-6 border border-[#1e293b] space-y-4 shadow-xl">
          <div className="flex items-center justify-between border-b border-[#1e293b] pb-3">
            <span className="font-bold text-slate-200 uppercase flex items-center gap-2">
              <Key className="w-4 h-4 text-[#00f0ff]" /> Personal Access Token (PAT) Configuration
            </span>
            <span className="text-[10px] text-emerald-400 flex items-center gap-1">
              <Lock className="w-3 h-3" /> AES-256-GCM Encrypted
            </span>
          </div>

          {maskedToken && (
            <div className="p-3 bg-[#0a0d14] rounded border border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-[#7000ff]/20 border border-[#7000ff] flex items-center justify-center text-[#7000ff]">
                  <User className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-white font-bold">@{username || "authenticated-user"}</div>
                  <div className="text-[11px] text-slate-500 font-mono">Active Key: {maskedToken}</div>
                </div>
              </div>
              <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-[10px] font-bold">
                CONNECTED
              </span>
            </div>
          )}

          <form onSubmit={handleVerifyAndSaveToken} className="space-y-4">
            <div>
              <label className="block text-slate-400 mb-1">
                {maskedToken ? "UPDATE / REPLACE PERSONAL ACCESS TOKEN" : "GITHUB PERSONAL ACCESS TOKEN"}
              </label>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white focus:outline-none focus:border-[#00f0ff] font-mono"
              />
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3 text-[11px] flex-wrap">
                <span className="text-slate-400">Required Scopes:</span>
                <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-[#00f0ff]">repo</span>
                <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-[#00f0ff]">workflow</span>
                <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-[#00f0ff]">admin:repo_hook</span>
              </div>
              <button
                type="submit"
                disabled={verifying || !token}
                className="px-4 py-2 rounded bg-[#00f0ff]/20 border border-[#00f0ff] text-[#00f0ff] font-bold hover:bg-[#00f0ff] hover:text-black transition-colors shadow-[0_0_15px_rgba(0,240,255,0.25)] flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {verifying ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                Save & Encrypt Credentials
              </button>
            </div>
          </form>

          {scopesValid && (
            <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded text-emerald-400 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>GitHub API Connection Verified! All required scopes (repo, workflow, admin:repo_hook) active.</span>
            </div>
          )}
        </div>

        {/* Repository Re-Binding Engine */}
        <div className="glass-panel rounded-xl p-6 border border-[#1e293b] space-y-4 shadow-xl">
          <div className="border-b border-[#1e293b] pb-3">
            <span className="font-bold text-slate-200 uppercase flex items-center gap-2">
              <LinkIcon className="w-4 h-4 text-[#7000ff]" /> Target Domain & Repository Re-binding Engine
            </span>
          </div>

          <form onSubmit={handleRebind} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-slate-400 mb-1">SELECT TARGET ENVIRONMENT</label>
              <select
                value={selectedDomain}
                onChange={(e) => {
                  setSelectedDomain(e.target.value);
                  const found = sites.find((s) => s.domain === e.target.value);
                  if (found) setSelectedRepo(found.repo);
                }}
                className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white focus:outline-none focus:border-[#7000ff]"
              >
                <option value="">-- Choose Target Environment --</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.domain}>
                    {s.domain} ({s.path})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-slate-400 mb-1">SELECT EXISTING REPOSITORY</label>
              <select
                value={selectedRepo}
                onChange={(e) => setSelectedRepo(e.target.value)}
                className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white focus:outline-none focus:border-[#7000ff]"
              >
                <option value="">-- Choose Known Repository --</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.repo}>
                    {s.repo} [{s.framework}]
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2">
              <label className="block text-slate-400 mb-1">OR ENTER CUSTOM REPOSITORY NAME / URL</label>
              <input
                type="text"
                value={customRepo}
                onChange={(e) => setCustomRepo(e.target.value)}
                placeholder="e.g. org/custom-microservice-api or user/new-repo"
                className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white focus:outline-none focus:border-[#7000ff]"
              />
            </div>

            <div className="md:col-span-2 flex justify-end">
              <button
                type="submit"
                disabled={rebinding || !selectedDomain || (!selectedRepo && !customRepo.trim())}
                className="px-5 py-2 rounded bg-[#7000ff]/20 border border-[#7000ff] text-[#7000ff] font-bold hover:bg-[#7000ff] hover:text-white transition-colors shadow-[0_0_15px_rgba(112,0,255,0.25)] disabled:opacity-50 flex items-center gap-2"
              >
                {rebinding ? <RefreshCw className="w-4 h-4 animate-spin" /> : <LinkIcon className="w-4 h-4" />}
                Apply Re-Binding & Update Storage
              </button>
            </div>
          </form>
        </div>
      </div>
    </FuturisticLayout>
  );
}

export default function GitHubSettingsPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#0a0d14] text-[#00f0ff] p-8 font-mono text-xs">Loading Settings...</div>}>
      <GitHubSettingsContent />
    </Suspense>
  );
}

