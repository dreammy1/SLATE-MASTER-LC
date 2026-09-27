"use client";

import React from "react";
import { Edit3, ExternalLink, Globe, HardDrive, Play, RefreshCw, Terminal, Trash2, Wrench } from "lucide-react";
import { MigrationJob } from "./types";

interface Props {
  job: MigrationJob;
  isMigrating: boolean;
  onStart: (id: string) => void;
  onRepairUrl?: (id: string) => void;
  onEdit?: (job: MigrationJob) => void;
  onDelete?: (jobId: string) => void;
}

export default function MigrationCard({ job, isMigrating, onStart, onRepairUrl, onEdit, onDelete }: Props) {
  const targets = job.targets?.length ? job.targets : [job.destination];

  return (
    <div className="glass-panel rounded-xl p-6 border border-[#1e293b] space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#1e293b] pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-slate-800 text-[#00f0ff] border border-slate-700 font-bold text-[10px]">
              JOB ID: {job.id}
            </span>
            <h3 className="text-base font-bold text-white font-mono">{job.title}</h3>
          </div>
          <p className="text-slate-400 mt-1 font-mono text-xs">
            Source: <span className="text-amber-400">{job.source.siteUrl}</span> ({job.source.fileManagerPath})
            {" "}&rarr;{" "}
            Destination: <span className="text-[#00f0ff]">{targets.length} import target(s)</span>
          </p>
        </div>

        <div className="flex items-center gap-3 font-mono text-xs">
          {job.status === "COMPLETED" && (
            <a
              href={job.destination.siteUrl}
              target="_blank"
              rel="noreferrer"
              className="px-4 py-2 rounded-lg bg-emerald-500/20 border border-emerald-500 text-emerald-400 hover:bg-emerald-500 hover:text-black font-bold transition-all flex items-center gap-1.5 shadow-[0_0_15px_rgba(16,185,129,0.3)]"
            >
              <Globe className="w-4 h-4" /> Open Live Mirror Site <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}

          {onEdit && (
            <button
              onClick={() => onEdit(job)}
              className="p-2.5 rounded-lg bg-slate-800 border border-slate-700 text-[#00f0ff] hover:bg-[#00f0ff] hover:text-black transition-all"
              title="Edit migration plan"
            >
              <Edit3 className="w-4 h-4" />
            </button>
          )}

          {onRepairUrl && (
            <button
              onClick={() => onRepairUrl(job.id)}
              disabled={isMigrating || job.status === "RUNNING"}
              className="px-4 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/40 text-amber-300 hover:bg-amber-500 hover:text-black font-bold transition-all flex items-center gap-2 disabled:opacity-50"
              title="Repair target APP_URL / base path without full migration"
            >
              <Wrench className="w-4 h-4" />
              Repair URL Config
            </button>
          )}

          {onDelete && (
            <button
              onClick={() => onDelete(job.id)}
              className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-400 hover:bg-rose-500 hover:text-black transition-all"
              title="Delete migration plan"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}

          <button
            onClick={() => onStart(job.id)}
            disabled={isMigrating || job.status === "RUNNING"}
            className="px-5 py-2 rounded-lg bg-[#00f0ff]/20 border border-[#00f0ff] text-[#00f0ff] hover:bg-[#00f0ff] hover:text-black font-bold transition-all shadow-[0_0_15px_rgba(0,240,255,0.25)] flex items-center gap-2 disabled:opacity-50"
          >
            {isMigrating ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-current" />}
            {job.status === "COMPLETED" ? "Re-Run Full Auto Migration" : "Start Auto Migration"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {targets.map((target, index) => (
          <div key={`${target.siteUrl}-${index}`} className="p-3 rounded bg-[#0a0d14]/80 border border-[#1e293b] font-mono text-xs">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[#00f0ff] font-bold">TARGET {index + 1}</span>
              <span className="text-slate-500">{target.cpanelHost}</span>
            </div>
            <div className="text-white font-semibold mt-1">{target.siteUrl}</div>
            <div className="text-slate-400 text-[11px] mt-1">
              {target.fileManagerPath} ({target.dbName || "no database selected"})
            </div>
          </div>
        ))}
      </div>

      {/* PROGRESS BAR & STATS */}
      <div className="p-4 rounded-lg bg-[#0a0d14]/80 border border-[#1e293b] space-y-4 font-mono">
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-300 font-bold flex items-center gap-2">
            <HardDrive className="w-4 h-4 text-[#00f0ff]" /> REPLICATION PROGRESS:
          </span>
          <span className="text-[#00f0ff] font-extrabold text-sm">{job.progress}%</span>
        </div>

        <div className="w-full bg-slate-800 h-3 rounded-full overflow-hidden p-0.5 border border-[#1e293b]">
          <div
            className="bg-gradient-to-r from-[#00f0ff] via-emerald-400 to-[#7000ff] h-full rounded-full transition-all duration-500 shadow-[0_0_12px_rgba(0,240,255,0.5)]"
            style={{ width: `${job.progress}%` }}
          />
        </div>

        <div className="text-[11px] text-slate-300 flex items-center gap-2">
          {isMigrating && <RefreshCw className="w-3.5 h-3.5 text-[#00f0ff] animate-spin" />}
          <span>{job.currentStep}</span>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-2 border-t border-[#1e293b]/60 text-xs">
          <div className="p-2.5 rounded bg-[#111625] border border-[#1e293b]">
            <div className="text-slate-400 text-[10px]">FILE TRANSFER COUNT</div>
            <div className="text-sm font-bold text-white mt-0.5">
              {job.transferredFiles.toLocaleString()} / {job.totalFiles.toLocaleString()} files
            </div>
          </div>

          <div className="p-2.5 rounded bg-[#111625] border border-[#1e293b]">
            <div className="text-slate-400 text-[10px]">DB TABLES SYNCHRONIZED</div>
            <div className="text-sm font-bold text-emerald-400 mt-0.5">
              {job.transferredDbTables} / {job.totalDbTables} tables
            </div>
          </div>

          <div className="p-2.5 rounded bg-[#111625] border border-[#1e293b]">
            <div className="text-slate-400 text-[10px]">URL REPLACEMENT</div>
            <div className="text-sm font-bold text-[#00f0ff] mt-0.5">
              {job.options.replaceDomainUrls ? "ACTIVE (AUTO)" : "OFF"}
            </div>
          </div>

          <div className="p-2.5 rounded bg-[#111625] border border-[#1e293b]">
            <div className="text-slate-400 text-[10px]">SYSTEM STATUS</div>
            <div className={`text-sm font-bold mt-0.5 ${job.status === "COMPLETED" ? "text-emerald-400" : "text-amber-400"}`}>
              {job.status}
            </div>
          </div>
        </div>
      </div>

      {/* STREAMING CONSOLE */}
      <div className="p-4 rounded-lg bg-black/90 border border-[#1e293b] font-mono text-[11px] space-y-2">
        <div className="flex items-center justify-between text-slate-400 border-b border-[#1e293b] pb-2">
          <span className="flex items-center gap-1.5 text-slate-200 font-bold">
            <Terminal className="w-3.5 h-3.5 text-[#00f0ff]" /> LIVE SERVER-TO-SERVER PROTOCOL STREAM
          </span>
          <span>{job.logs.length} EVENTS RECORDED</span>
        </div>
        <div className="max-h-56 overflow-y-auto space-y-1.5 pt-1">
          {job.logs.map((log, index) => (
            <div key={index} className="flex items-start gap-2">
              <span className="text-slate-500">[{log.timestamp}]</span>
              {log.type === "success" && <span className="text-emerald-400 font-bold">[SUCCESS]</span>}
              {log.type === "info" && <span className="text-[#00f0ff]">[INFO]</span>}
              {log.type === "warn" && <span className="text-amber-400">[WARN]</span>}
              {log.type === "error" && <span className="text-rose-400 font-bold">[ERROR]</span>}
              <span className="text-slate-200">{log.message}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
