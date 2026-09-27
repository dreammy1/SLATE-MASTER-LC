"use client";

import React, { useState } from "react";
import { UploadCloud, FolderPlus, GitBranch, Loader2, X, CheckCircle2, FileArchive, Globe } from "lucide-react";

interface CreateRepoModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (repo: any) => void;
}

export default function CreateRepoModal({ isOpen, onClose, onSuccess }: CreateRepoModalProps) {
  const [repoName, setRepoName] = useState("");
  const [domain, setDomain] = useState("https://whatever-bar.de");
  const [description, setDescription] = useState("");
  const [framework, setFramework] = useState("php");
  const [isPrivate, setIsPrivate] = useState(true);
  const [targetPath, setTargetPath] = useState("/public_html/slate");
  const [zipFile, setZipFile] = useState<File | null>(null);

  // Live Progress & File Counter States
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentFile, setCurrentFile] = useState(0);
  const [totalFiles, setTotalFiles] = useState(0);
  const [currentFileName, setCurrentFileName] = useState("");
  const [stage, setStage] = useState("INITIALIZING");
  const [statusText, setStatusText] = useState("");

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!repoName) return;

    setLoading(true);
    setProgress(2);
    setCurrentFile(0);
    setTotalFiles(0);
    setCurrentFileName("");
    setStage("INITIALIZING");
    setStatusText("Preparing project payload & authenticating with GitHub...");

    try {
      const formData = new FormData();
      if (zipFile) formData.append("file", zipFile);
      formData.append("repoName", repoName);
      formData.append("domain", domain);
      formData.append("description", description);
      formData.append("framework", framework);
      formData.append("isPrivate", String(isPrivate));
      formData.append("targetPath", targetPath);

      const res = await fetch("/api/github/scaffold", {
        method: "POST",
        body: formData,
      });

      if (!res.ok && !res.body) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Scaffolding failed");
      }

      // Check if streaming NDJSON
      const contentType = res.headers.get("content-type") || "";
      let finalResult: any = null;

      if (contentType.includes("ndjson") && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              if (event.error) {
                throw new Error(event.error);
              }
              if (typeof event.percent === "number") {
                setProgress(Math.min(100, Math.max(0, event.percent)));
              }
              if (typeof event.currentFile === "number") {
                setCurrentFile(event.currentFile);
              }
              if (typeof event.totalFiles === "number") {
                setTotalFiles(event.totalFiles);
              }
              if (event.currentFileName) {
                setCurrentFileName(event.currentFileName);
              }
              if (event.stage) {
                setStage(event.stage);
              }
              if (event.message) {
                setStatusText(event.message);
              }
              if (event.done) {
                finalResult = event;
                setProgress(100);
              }
            } catch (err: any) {
              if (err.message && !err.message.includes("JSON")) {
                throw err;
              }
            }
          }
        }
      } else {
        // Fallback for non-streaming response
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Scaffolding failed");
        finalResult = data;
        setProgress(100);
      }

      setStage("COMPLETE");
      setProgress(100);
      setStatusText(
        `Repository scaffolded successfully! (${finalResult?.repo?.filesUploaded || totalFiles || 0} files pushed)`
      );

      setTimeout(() => {
        onSuccess(finalResult?.site || finalResult?.repo || {});
        onClose();
        setRepoName("");
        setDescription("");
        setZipFile(null);
        setProgress(0);
        setCurrentFile(0);
        setTotalFiles(0);
      }, 1500);
    } catch (err: any) {
      setLoading(false);
      setStatusText("");
      setProgress(0);
      alert("Scaffolding Error: " + err.message);
    } finally {
      if (progress >= 100) {
        setLoading(false);
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
      <div className="glass-panel w-full max-w-xl rounded-xl p-6 shadow-2xl border border-[#00f0ff]/40 space-y-5 relative">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#1e293b] pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-[#00f0ff]/10 border border-[#00f0ff]/30 text-[#00f0ff]">
              <FolderPlus className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-mono font-bold text-base text-white tracking-wide flex items-center gap-2">
                CREATE REPOSITORY & SCAFFOLD ZIP
              </h2>
              <p className="text-xs text-slate-400 font-mono">Automated CI/CD injection & live file streaming engine</p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={loading}
            className="text-slate-400 hover:text-white transition-colors disabled:opacity-30"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 font-mono text-xs">
          {/* ZIP Upload Box */}
          <div
            className={`border-2 border-dashed rounded-lg p-5 flex flex-col items-center justify-center text-center cursor-pointer transition-all ${
              zipFile
                ? "border-[#00f0ff] bg-[#00f0ff]/5 shadow-[0_0_15px_rgba(0,240,255,0.1)]"
                : "border-[#1e293b] hover:border-[#00f0ff]/60 bg-[#0a0d14]/40"
            }`}
          >
            <input
              type="file"
              accept=".zip"
              disabled={loading}
              className="hidden"
              id="zip-upload"
              onChange={(e) => setZipFile(e.target.files?.[0] || null)}
            />
            <label htmlFor="zip-upload" className="cursor-pointer space-y-2 w-full">
              {zipFile ? (
                <div className="flex flex-col items-center gap-1.5">
                  <div className="w-10 h-10 rounded-full bg-[#00f0ff]/20 text-[#00f0ff] flex items-center justify-center shadow-[0_0_10px_rgba(0,240,255,0.3)]">
                    <FileArchive className="w-5 h-5" />
                  </div>
                  <div className="text-white font-bold text-sm tracking-wide">{zipFile.name}</div>
                  <div className="text-[11px] text-[#00f0ff] font-semibold">
                    {(zipFile.size / 1024 / 1024).toFixed(2)} MB &bull; Ready to Scaffold
                  </div>
                </div>
              ) : (
                <>
                  <UploadCloud className="w-8 h-8 text-[#00f0ff] mx-auto animate-bounce" />
                  <div className="text-slate-200 font-semibold">Drop Project ZIP Archive Here (Optional)</div>
                  <p className="text-[11px] text-slate-500">
                    Supports WordPress plugins/themes, Laravel, Custom PHP, React
                  </p>
                </>
              )}
            </label>
          </div>

          {/* Repo Name & Framework */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-slate-300 mb-1">REPOSITORY NAME</label>
              <input
                type="text"
                required
                disabled={loading}
                value={repoName}
                onChange={(e) => setRepoName(e.target.value)}
                placeholder="e.g. zen-1 or Slate-dev"
                className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white focus:outline-none focus:border-[#00f0ff] disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-slate-300 mb-1">FRAMEWORK / TYPE</label>
              <select
                value={framework}
                disabled={loading}
                onChange={(e) => setFramework(e.target.value)}
                className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white focus:outline-none focus:border-[#00f0ff] disabled:opacity-50"
              >
                <option value="php">Vanilla / Custom PHP</option>
                <option value="wordpress">WordPress (Plugin / Theme)</option>
                <option value="laravel">Laravel / PHP App</option>
                <option value="react">React / Node.js SPA</option>
              </select>
            </div>
          </div>

          {/* Target Domain & Server Path */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-slate-300 mb-1 flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-[#00f0ff]" />
                TARGET DOMAIN
              </label>
              <input
                type="text"
                disabled={loading}
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="https://whatever-bar.de"
                className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white focus:outline-none focus:border-[#00f0ff] disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-slate-300 mb-1">TARGET SERVER PATH</label>
              <input
                type="text"
                disabled={loading}
                value={targetPath}
                onChange={(e) => setTargetPath(e.target.value)}
                placeholder="/public_html/slate"
                className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white focus:outline-none focus:border-[#00f0ff] disabled:opacity-50"
              />
            </div>
          </div>

          {/* Private Repo Toggle */}
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="private-repo"
              disabled={loading}
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
              className="accent-[#00f0ff] rounded cursor-pointer disabled:opacity-50"
            />
            <label htmlFor="private-repo" className="text-slate-300 cursor-pointer select-none">
              Set GitHub Repository as Private
            </label>
          </div>

          {/* LIVE PROGRESS BAR (0 to 100%) WITH FILE COUNTING TOTAL */}
          {loading && (
            <div className="p-4 bg-[#080b12] border border-[#00f0ff]/50 rounded-xl space-y-3 shadow-[0_0_25px_rgba(0,240,255,0.18)] relative overflow-hidden animate-in fade-in duration-200">
              {/* Top ambient glow */}
              <div className="absolute top-0 right-0 w-36 h-36 bg-[#00f0ff]/10 blur-2xl pointer-events-none" />

              {/* Header: Stage Badge + Percentage 0-100% */}
              <div className="flex items-center justify-between font-mono">
                <div className="flex items-center gap-2">
                  {progress >= 100 ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <Loader2 className="w-4 h-4 text-[#00f0ff] animate-spin" />
                  )}
                  <span className="text-[11px] font-bold text-[#00f0ff] tracking-wider uppercase">
                    {stage}
                  </span>
                </div>
                <div className="font-mono text-white flex items-baseline gap-1">
                  <span className="text-2xl font-black text-[#00f0ff] drop-shadow-[0_0_8px_rgba(0,240,255,0.5)]">
                    {progress}%
                  </span>
                </div>
              </div>

              {/* Glowing 0 to 100% Progress Bar Track */}
              <div className="w-full bg-[#111625] h-3.5 rounded-full overflow-hidden border border-[#1e293b] p-[2px] shadow-inner">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[#00f0ff] via-[#3b82f6] to-[#10b981] transition-all duration-300 ease-out shadow-[0_0_14px_rgba(0,240,255,0.8)] relative"
                  style={{ width: `${Math.max(progress, 2)}%` }}
                >
                  <div className="absolute inset-0 bg-white/25 animate-pulse rounded-full" />
                </div>
              </div>

              {/* File Counting Total (Files: X / Y) & Current Filename */}
              <div className="flex items-center justify-between text-[11px] font-mono pt-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-slate-400 font-semibold">FILES:</span>
                  <span className="text-[#00f0ff] font-bold text-xs">
                    {currentFile} <span className="text-slate-500">/</span> {totalFiles || "—"}
                  </span>
                  {totalFiles > 0 && (
                    <span className="text-slate-400 text-[10px]">
                      ({Math.round((currentFile / totalFiles) * 100)}% complete)
                    </span>
                  )}
                </div>
                <div
                  className="text-slate-300 text-[10px] truncate max-w-[260px] text-right font-mono"
                  title={currentFileName}
                >
                  {currentFileName ? `› ${currentFileName}` : ""}
                </div>
              </div>

              {/* Live Terminal Log Line */}
              <div className="text-[10px] text-slate-300 font-mono bg-[#03060a] px-3 py-2 rounded-lg border border-[#1e293b] flex items-center gap-2 shadow-inner">
                <span className="text-[#00f0ff] font-bold">›</span>
                <span className="truncate">{statusText || "Processing..."}</span>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex justify-end gap-3 pt-3 border-t border-[#1e293b]">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 rounded bg-[#111625] hover:bg-[#171f33] border border-[#1e293b] text-slate-300 transition-colors disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !repoName}
              className="px-5 py-2 rounded bg-[#00f0ff]/20 border border-[#00f0ff] text-[#00f0ff] hover:bg-[#00f0ff] hover:text-black transition-all font-bold shadow-[0_0_15px_rgba(0,240,255,0.25)] flex items-center gap-2 disabled:opacity-50"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Scaffolding ({progress}%)</span>
                </>
              ) : (
                <>
                  <GitBranch className="w-4 h-4" />
                  <span>Scaffold & Push to GitHub</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
