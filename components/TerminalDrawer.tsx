"use client";

import React, { useState, useEffect, useRef } from "react";
import { Terminal, X, Play, Trash2, RefreshCw, ChevronRight } from "lucide-react";

interface TerminalDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  siteId?: string | null;
  siteDomain?: string | null;
}

export default function TerminalDrawer({ isOpen, onClose, siteId, siteDomain }: TerminalDrawerProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [cliInput, setCliInput] = useState("");
  const [executing, setExecuting] = useState(false);
  const consoleBottomRef = useRef<HTMLDivElement>(null);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const url = siteId ? `/api/deployments?siteId=${siteId}` : `/api/deployments`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success && data.deployments) {
        const aggregatedLogs: string[] = [];
        data.deployments.forEach((d: any) => {
          aggregatedLogs.push(`=== DEPLOYMENT [${d.id}] - ${d.domain} (${d.commitSha}) ===`);
          if (Array.isArray(d.logs)) {
            aggregatedLogs.push(...d.logs);
          }
          aggregatedLogs.push("");
        });

        if (aggregatedLogs.length === 0) {
          aggregatedLogs.push(`[${new Date().toLocaleTimeString()}] No deployments on record. Type 'slate help' to view commands.`);
        }
        setLogs(aggregatedLogs);
      }
    } catch {
      setLogs([`[${new Date().toLocaleTimeString()}] Failed to load deployment logs stream.`]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchLogs();
    }
  }, [isOpen, siteId]);

  useEffect(() => {
    consoleBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  if (!isOpen) return null;

  const handleRunCommand = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cliInput.trim()) return;

    const cmd = cliInput.trim();
    setCliInput("");
    setExecuting(true);

    setLogs((prev) => [...prev, `slate-ops@cluster:~$ ${cmd}`]);

    try {
      const res = await fetch("/api/terminal/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd }),
      });
      const data = await res.json();

      if (data.output && data.output[0] === "__CLEAR__") {
        setLogs([]);
      } else if (data.output) {
        setLogs((prev) => [...prev, ...data.output]);
      }
    } catch {
      setLogs((prev) => [...prev, `Error: Failed to connect to terminal runtime engine.`]);
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-2 sm:p-4">
      <div className="glass-panel w-full max-w-4xl h-[75vh] sm:h-[85vh] rounded-xl flex flex-col border border-[#00f0ff]/40 shadow-2xl overflow-hidden font-mono text-xs">
        {/* Terminal Header */}
        <div className="h-12 bg-[#0a0d14] border-b border-[#1e293b] px-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-rose-500/80 cursor-pointer" onClick={onClose} />
              <span className="w-3 h-3 rounded-full bg-amber-500/80" />
              <span className="w-3 h-3 rounded-full bg-emerald-500/80" />
            </div>
            <div className="flex items-center gap-2 text-slate-200 font-bold ml-2">
              <Terminal className="w-4 h-4 text-[#00f0ff]" />
              <span>LIVE CLUSTER CONSOLE & LOGS</span>
              {siteDomain && (
                <span className="px-2 py-0.5 rounded bg-[#00f0ff]/10 text-[#00f0ff] border border-[#00f0ff]/30 text-[10px]">
                  {siteDomain}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={fetchLogs}
              className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-white"
              title="Refresh Logs"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin text-[#00f0ff]" : ""}`} />
            </button>
            <button
              onClick={() => setLogs([])}
              className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-white"
              title="Clear View"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            <button onClick={onClose} className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Console Log Output Body */}
        <div className="flex-1 bg-[#07090e] p-4 overflow-y-auto space-y-1 select-text scrollbar-thin scrollbar-thumb-slate-800">
          <div className="text-slate-500 text-[11px] pb-2 border-b border-slate-900">
            SLATE TELEMETRY STREAM ESTABLISHED. Real-time CI/CD and system logs active.
          </div>

          {logs.map((line, idx) => {
            let color = "text-slate-300";
            if (line.includes("SUCCESS") || line.includes("200 OK") || line.includes("ONLINE")) {
              color = "text-emerald-400 font-semibold";
            } else if (line.includes("Error") || line.includes("FAILED") || line.includes("500")) {
              color = "text-rose-400 font-bold";
            } else if (line.includes("INITIATING") || line.includes("TRIGGERING") || line.includes("BUILD")) {
              color = "text-[#00f0ff] font-semibold";
            } else if (line.startsWith("slate-ops@cluster")) {
              color = "text-amber-300 font-bold";
            } else if (line.startsWith("===")) {
              color = "text-[#7000ff] font-bold py-1";
            }

            return (
              <div key={idx} className={`${color} leading-relaxed text-[11px] font-mono break-all`}>
                {line}
              </div>
            );
          })}
          <div ref={consoleBottomRef} />
        </div>

        {/* Command Line Input Footer */}
        <form onSubmit={handleRunCommand} className="h-12 bg-[#0a0d14] border-t border-[#1e293b] px-3 flex items-center gap-2 shrink-0">
          <div className="flex items-center gap-1 text-[#00f0ff] shrink-0 font-bold text-xs">
            <span>slate-ops@cluster</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </div>
          <input
            type="text"
            value={cliInput}
            onChange={(e) => setCliInput(e.target.value)}
            placeholder="Type 'slate help', 'slate deploy <site>', 'slate sites', 'slate ping <site>'..."
            className="flex-1 bg-transparent border-none text-white text-xs font-mono focus:outline-none placeholder-slate-600"
            disabled={executing}
          />
          <button
            type="submit"
            disabled={executing || !cliInput.trim()}
            className="px-3 py-1 rounded bg-[#00f0ff]/20 text-[#00f0ff] border border-[#00f0ff]/40 hover:bg-[#00f0ff] hover:text-black transition-colors font-bold text-xs flex items-center gap-1 disabled:opacity-40"
          >
            <Play className="w-3 h-3 fill-current" /> Run
          </button>
        </form>
      </div>
    </div>
  );
}
