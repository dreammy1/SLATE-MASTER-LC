"use client";

import React, { useState, useEffect } from "react";
import FuturisticLayout from "@/components/FuturisticLayout";
import { ArrowRightLeft, Plus } from "lucide-react";
import { MigrationJob } from "@/components/migration/types";
import MigrationCard from "@/components/migration/MigrationCard";
import MigrationForm from "@/components/migration/MigrationForm";
import MigrationList from "@/components/migration/MigrationList";

export default function MigrationPage() {
  const [jobs, setJobs] = useState<MigrationJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<MigrationJob | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [editingJob, setEditingJob] = useState<MigrationJob | null>(null);
  const [isMigrating, setIsMigrating] = useState(false);
  const [sites, setSites] = useState<any[]>([]);
  const [databases, setDatabases] = useState<any[]>([]);

  const fetchJobs = async () => {
    try {
      const res = await fetch("/api/migrations");
      const data = await res.json();
      if (data.success) {
        setJobs(data.jobs);
        if (data.jobs.length > 0 && !selectedJob) {
          setSelectedJob(data.jobs[0]);
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchJobs();
    fetch("/api/sites")
      .then((res) => res.json())
      .then((data) => {
        if (data.success) setSites(data.sites || []);
      })
      .catch(console.error);
    fetch("/api/databases")
      .then((res) => res.json())
      .then((data) => {
        if (data.success) setDatabases(data.databases || []);
      })
      .catch(console.error);
  }, []);

  const handleSaveJob = async (payload: any) => {
    try {
      const res = await fetch("/api/migrations", {
        method: payload.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        setJobs((prev) => payload.id ? prev.map((job) => job.id === data.job.id ? data.job : job) : [data.job, ...prev]);
        setSelectedJob(data.job);
        setIsCreating(false);
        setEditingJob(null);
      } else {
        alert("Failed to save migration: " + (data.error || data.message || "Unknown error"));
      }
    } catch (err: any) {
      alert("Failed to save migration: " + err.message);
    }
  };

  const handleEditJob = (job: MigrationJob) => {
    setEditingJob(job);
    setIsCreating(true);
    setSelectedJob(job);
  };

  const handleDeleteJob = async (jobId: string) => {
    if (!confirm("Delete this migration plan?")) return;

    try {
      const res = await fetch(`/api/migrations?id=${encodeURIComponent(jobId)}`, { method: "DELETE" });
      const data = await res.json();

      if (!data.success) {
        alert("Failed to delete migration: " + (data.error || data.message || "Unknown error"));
        return;
      }

      setJobs((prev) => {
        const next = prev.filter((job) => job.id !== jobId);
        setSelectedJob((current) => current?.id === jobId ? next[0] || null : current);
        return next;
      });
      if (editingJob?.id === jobId) {
        setEditingJob(null);
        setIsCreating(false);
      }
    } catch (err: any) {
      alert("Failed to delete migration: " + err.message);
    }
  };

  const fetchOneJob = async (jobId: string) => {
    try {
      const res = await fetch("/api/migrations");
      const data = await res.json();
      if (data.success && Array.isArray(data.jobs)) {
        const found = data.jobs.find((j: any) => j.id === jobId);
        if (found) setSelectedJob(found);
        return found;
      }
    } catch {}
    return undefined;
  };

  const handleStartMigration = async (jobId: string) => {
    setIsMigrating(true);
    let lastJob: any = null;
    try {
      const res = await fetch("/api/migrations/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: jobId })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        alert("Migration failed to start: " + (data.message || data.error || `HTTP ${res.status}`));
        return;
      }
      if (data.job) {
        setSelectedJob(data.job);
        lastJob = data.job;
      }

      const STEP_WAIT_MS = 2000;
      for (let s = 1; s <= 4; s++) {
        // Brief breath between long-running server steps; UI will stream via fetchOneJob refresh below.
        await new Promise((r) => setTimeout(r, STEP_WAIT_MS));

        // Kick off the real server-side step. NOTE: server will NOT return until step work is DONE.
        // This call may take 30s to several minutes depending on file/DB size.
        const resStep = await fetch("/api/migrations/start", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: jobId, step: s })
        });
        const dataStep = await resStep.json().catch(() => ({ success: false, message: `HTTP ${resStep.status} (bad JSON)` }));

        if (dataStep.job) {
          setSelectedJob(dataStep.job);
          lastJob = dataStep.job;
        } else {
          // Fallback: refresh from GET list
          const refreshed = await fetchOneJob(jobId);
          if (refreshed) lastJob = refreshed;
        }

        // Stop early if the step or pipeline explicitly failed
        const failed =
          dataStep.success === false ||
          lastJob?.status === "FAILED" ||
          (dataStep.stepResult && dataStep.stepResult.ok === false);

        if (failed || !resStep.ok) {
          const why =
            dataStep.message ||
            dataStep.error ||
            lastJob?.error ||
            (dataStep.stepResult?.message) ||
            `Migration step ${s} returned HTTP ${resStep.status}.`;
          alert(
            `MIGRATION FAILED at Step ${s}/4:\n\n${why}\n\n` +
            `What to check next:\n` +
            ` 1. Confirm auth.php is uploaded to BOTH source AND target folder paths\n` +
            ` 2. Confirm source.siteUrl + source.fileManagerPath resolve to the source auth.php over HTTPS\n` +
            ` 3. Confirm target.siteUrl + target.fileManagerPath resolve to target auth.php\n` +
            ` 4. Confirm source DB credentials (dbName/dbUser/dbPass) match wp-config/.env on source\n` +
            ` 5. Open the live stream console above for full per-target logs`
          );
          fetchJobs();
          return;
        }
      }

      fetchJobs();
    } catch (err: any) {
      alert(
        `Migration Pipeline Network/Crash Error: ${err.message || err}\n\n` +
        `This usually means the browser fetch timed out on a long step.\n` +
        `Refresh the Migrations page and check the LIVE STREAM console for actual server-side progress — the server-side step may have completed even if the browser disconnected.`
      );
      await fetchOneJob(jobId);
      fetchJobs();
    } finally {
      setIsMigrating(false);
    }
  };

  const handleRepairUrl = async (jobId: string) => {
    setIsMigrating(true);
    try {
      const res = await fetch("/api/migrations/repair-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: jobId })
      });
      const data = await res.json();
      if (data.job) {
        setSelectedJob(data.job);
        setJobs((prev) => prev.map((job) => job.id === data.job.id ? data.job : job));
      }
      if (!data.success) {
        alert("URL repair failed: " + (data.message || data.error || "Review migration logs"));
      }
    } catch (err: any) {
      alert("URL repair failed: " + err.message);
    } finally {
      setIsMigrating(false);
    }
  };

  return (
    <FuturisticLayout activeTab="migrations">
      <div className="space-y-6 font-mono text-xs">
        {/* Top Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-mono font-extrabold text-white tracking-wider flex items-center gap-2">
              <ArrowRightLeft className="w-6 h-6 text-[#00f0ff] animate-pulse" />
              SERVER-TO-SERVER AUTO MIGRATION & REPLICATION ENGINE
            </h2>
            <p className="text-slate-400">
              Zero-touch cPanel file manager synchronization, dynamic database clone, and live URL mirror translation
            </p>
          </div>
          <button
            onClick={() => {
              setEditingJob(null);
              setIsCreating(!isCreating);
            }}
            className="px-4 py-2.5 rounded-lg bg-[#00f0ff]/20 border border-[#00f0ff] text-[#00f0ff] hover:bg-[#00f0ff] hover:text-black transition-all font-bold shadow-[0_0_15px_rgba(0,240,255,0.25)] flex items-center gap-2 self-start"
          >
            <Plus className="w-4 h-4" /> {isCreating ? "Close Configuration" : "New Import Target Plan"}
          </button>
        </div>

        {/* Staging Form Modal/Card */}
        {isCreating && (
          <MigrationForm
            initialJob={editingJob}
            sites={sites}
            databases={databases}
            onSave={handleSaveJob}
            onCancel={() => {
              setEditingJob(null);
              setIsCreating(false);
            }}
          />
        )}

        {/* Active Workspace / Execution Card */}
        {selectedJob && (
          <MigrationCard
            job={selectedJob}
            isMigrating={isMigrating}
            onStart={handleStartMigration}
            onRepairUrl={handleRepairUrl}
            onEdit={handleEditJob}
            onDelete={handleDeleteJob}
          />
        )}

        {/* Catalog Table */}
        <MigrationList jobs={jobs} onSelect={(job) => setSelectedJob(job)} onEdit={handleEditJob} onDelete={handleDeleteJob} />
      </div>
    </FuturisticLayout>
  );
}
