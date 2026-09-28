"use client";

import React from "react";
import { CheckCircle2, Clock, Edit3, ExternalLink, Trash2 } from "lucide-react";
import { MigrationJob } from "./types";

interface Props {
  jobs: MigrationJob[];
  onSelect: (job: MigrationJob) => void;
  onEdit: (job: MigrationJob) => void;
  onDelete: (jobId: string) => void;
}

export default function MigrationList({ jobs, onSelect, onEdit, onDelete }: Props) {
  return (
    <div className="glass-panel rounded-xl border border-[#1e293b] overflow-hidden font-mono text-xs">
      <div className="p-4 border-b border-[#1e293b] font-bold text-slate-200 flex items-center justify-between">
        <span>SAVED SERVER MIGRATION PLANS</span>
        <span className="text-xs text-slate-500 font-normal">{jobs.length} Plan(s)</span>
      </div>

      <div className="table-scroll">
      <table className="w-full text-left font-mono text-xs">
        <thead className="bg-[#0a0d14]/80 border-b border-[#1e293b] text-slate-400 uppercase text-[10px]">
          <tr>
            <th className="py-3 px-4">Plan Title</th>
            <th className="py-3 px-4">Export Source Server</th>
            <th className="py-3 px-4">Import Destination</th>
            <th className="py-3 px-4">Transfer Stats</th>
            <th className="py-3 px-4">Status</th>
            <th className="py-3 px-4 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#1e293b]/60 text-slate-200">
          {jobs.map((job) => {
            const targets = job.targets?.length ? job.targets : [job.destination];

            return (
            <tr key={job.id} className="hover:bg-[#171f33]/80 transition-colors">
              <td className="py-3.5 px-4 font-bold text-white">
                {job.title}
                <div className="text-[10px] text-slate-500 font-normal">
                  Created: {new Date(job.createdAt).toLocaleDateString()}
                </div>
              </td>
              <td className="py-3.5 px-4">
                <div className="text-amber-400 font-semibold">{job.source.cpanelHost}</div>
                <div className="text-[10px] text-slate-400">
                  {job.source.fileManagerPath} ({job.source.dbName})
                </div>
              </td>
              <td className="py-3.5 px-4">
                <div className="text-[#00f0ff] font-semibold">{targets[0]?.siteUrl}</div>
                <div className="text-[10px] text-slate-400">
                  {targets[0]?.fileManagerPath} ({targets[0]?.dbName})
                </div>
                {targets.length > 1 && (
                  <div className="text-[10px] text-emerald-400 mt-1">
                    + {targets.length - 1} more import target(s)
                  </div>
                )}
              </td>
              <td className="py-3.5 px-4">
                <div>{job.transferredFiles} / {job.totalFiles} files</div>
                <div className="text-[10px] text-slate-400">
                  {job.transferredDbTables} / {job.totalDbTables} tables
                </div>
              </td>
              <td className="py-3.5 px-4">
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold ${
                  job.status === "COMPLETED"
                    ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                    : "bg-amber-500/10 text-amber-400 border border-amber-500/30"
                }`}>
                  {job.status === "COMPLETED" ? <CheckCircle2 className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
                  {job.status}
                </span>
              </td>
              <td className="py-3.5 px-4 text-right">
                <div className="flex justify-end gap-1.5">
                <button
                  onClick={() => onSelect(job)}
                  className="px-3 py-2 sm:py-1.5 rounded bg-slate-800 hover:bg-[#00f0ff] hover:text-black border border-slate-700 font-bold transition-colors min-h-[36px] whitespace-nowrap"
                >
                  Select &amp; Manage
                </button>
                <button
                  onClick={() => onEdit(job)}
                  className="p-2 sm:p-1.5 rounded bg-slate-800 hover:bg-[#00f0ff] hover:text-black border border-slate-700 text-[#00f0ff] inline-flex items-center justify-center transition-colors min-w-[36px] min-h-[36px]"
                  title="Edit migration plan"
                >
                  <Edit3 className="w-3.5 h-3.5 shrink-0" />
                </button>
                <button
                  onClick={() => onDelete(job.id)}
                  className="p-2 sm:p-1.5 rounded bg-rose-500/10 border border-rose-500/30 text-rose-400 hover:bg-rose-500 hover:text-black inline-flex items-center justify-center transition-colors min-w-[36px] min-h-[36px]"
                  title="Delete migration plan"
                >
                  <Trash2 className="w-3.5 h-3.5 shrink-0" />
                </button>
                {job.status === "COMPLETED" && (
                  <a
                    href={job.destination.siteUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="p-2 sm:p-1.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500 hover:text-black inline-flex items-center justify-center transition-colors min-w-[36px] min-h-[36px]"
                    title="Visit Mirror Site"
                  >
                    <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                  </a>
                )}
                </div>
              </td>
            </tr>
          )})}
        </tbody>
      </table>
      </div>
    </div>
  );
}
