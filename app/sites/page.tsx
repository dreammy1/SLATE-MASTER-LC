"use client";

import React, { useState, useEffect, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import FuturisticLayout from "@/components/FuturisticLayout";
import AddSiteModal from "@/components/AddSiteModal";
import CreateRepoModal from "@/components/CreateRepoModal";
import EditSiteModal from "@/components/EditSiteModal";
import ProvisionDbModal from "@/components/ProvisionDbModal";
import DatabasePanel from "@/components/DatabasePanel";
import TerminalDrawer from "@/components/TerminalDrawer";
import { Site, DatabaseItem, DeploymentRecord } from "@/lib/storage";
import { 
  Server, 
  RefreshCw, 
  Database, 
  Terminal, 
  ExternalLink, 
  Plus, 
  FolderPlus, 
  CheckCircle, 
  XCircle,
  Activity,
  CheckCircle2,
  Trash2,
  Edit2,
  Radio,
  Wifi,
  Shield,
  Layers,
  FileCode,
  Clock,
  Play,
  ChevronDown,
  ChevronUp
} from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

const defaultTelemetryData = [
  { time: "05:00", latency: 42, cpu: 12 },
  { time: "05:05", latency: 38, cpu: 15 },
  { time: "05:10", latency: 55, cpu: 22 },
  { time: "05:15", latency: 41, cpu: 14 },
  { time: "05:20", latency: 44, cpu: 13 },
  { time: "05:25", latency: 36, cpu: 11 },
  { time: "05:30", latency: 28, cpu: 14 },
];

import { Suspense } from "react";

function SitesDashboardContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const activeTab = searchParams.get("tab") || "targets";

  const [sites, setSites] = useState<Site[]>([]);
  const [databases, setDatabases] = useState<DatabaseItem[]>([]);
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [bannerNotice, setBannerNotice] = useState("");

  // Modals state
  const [isAddSiteOpen, setIsAddSiteOpen] = useState(false);
  const [isCreateRepoOpen, setIsCreateRepoOpen] = useState(false);
  const [editingSite, setEditingSite] = useState<Site | null>(null);
  const [isProvisionDbOpen, setIsProvisionDbOpen] = useState(false);
  const [terminalTarget, setTerminalTarget] = useState<{ id: string | null; domain: string | null } | null>(null);
  const [expandedDbSiteId, setExpandedDbSiteId] = useState<string | null>(null);
  const [selectedDbSiteId, setSelectedDbSiteId] = useState<string>("");

  // Fetch initial data
  const fetchData = async () => {
    try {
      const [sitesRes, dbsRes, depsRes] = await Promise.all([
        fetch("/api/sites"),
        fetch("/api/databases"),
        fetch("/api/deployments"),
      ]);

      const [sitesData, dbsData, depsData] = await Promise.all([
        sitesRes.json(),
        dbsRes.json(),
        depsRes.json(),
      ]);

      if (sitesData.success) setSites(sitesData.sites);
      if (dbsData.success) setDatabases(dbsData.databases);
      if (depsData.success) setDeployments(depsData.deployments);
    } catch {
      setBannerNotice("Failed to synchronize with local storage engine.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleTabChange = (tab: string) => {
    router.push(`/sites?tab=${tab}`);
  };

  // Redeploy site action
  const handleRedeploy = async (siteId: string) => {
    setSites((prev) => prev.map((s) => (s.id === siteId ? { ...s, status: "DEPLOYING" } : s)));
    setBannerNotice(`[DISPATCH] Automated CI/CD pipeline triggered for ${siteId}...`);

    try {
      const res = await fetch(`/api/sites/${siteId}/redeploy`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setSites((prev) => prev.map((s) => (s.id === siteId ? data.site : s)));
        setBannerNotice(`[SUCCESS] Redeployment artifact unpacked for ${data.site.domain}. Target is ONLINE.`);
        fetchData(); // refresh deployments list
      }
    } catch (err: any) {
      setBannerNotice(`[ERROR] Redeployment failed: ${err.message}`);
    } finally {
      setTimeout(() => setBannerNotice(""), 4000);
    }
  };

  // Sync DB action
  const handleSyncDb = async (siteId: string) => {
    try {
      const res = await fetch(`/api/sites/${siteId}/sync-db`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setSites((prev) => prev.map((s) => (s.id === siteId ? data.site : s)));
        setBannerNotice(`[DB-ENGINE] Dynamic synchronization succeeded: ${data.message}`);
      }
    } catch (err: any) {
      setBannerNotice(`[ERROR] DB Sync failed: ${err.message}`);
    } finally {
      setTimeout(() => setBannerNotice(""), 4000);
    }
  };

  // Ping action
  const handlePing = async (siteId: string) => {
    try {
      const res = await fetch(`/api/sites/${siteId}/ping`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setSites((prev) => prev.map((s) => (s.id === siteId ? data.site : s)));
        setBannerNotice(`[PING] Measured response time for ${data.site.domain}: ${data.latency}`);
      }
    } catch (err: any) {
      setBannerNotice(`[ERROR] Ping failed: ${err.message}`);
    } finally {
      setTimeout(() => setBannerNotice(""), 3500);
    }
  };

  // Delete site action
  const handleDeleteSite = async (site: Site) => {
    if (!confirm(`Are you sure you want to remove target domain '${site.domain}' from SLATE OS?`)) {
      return;
    }

    try {
      const res = await fetch(`/api/sites/${site.id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        setSites((prev) => prev.filter((s) => s.id !== site.id));
        setBannerNotice(`[REMOVED] Target domain '${site.domain}' removed.`);
      }
    } catch (err: any) {
      alert("Error deleting site: " + err.message);
    } finally {
      setTimeout(() => setBannerNotice(""), 3000);
    }
  };

  // Delete database action
  const handleDeleteDb = async (db: DatabaseItem) => {
    if (!confirm(`Remove database record '${db.name}' from managed instances?`)) {
      return;
    }

    try {
      const res = await fetch(`/api/databases/${db.id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        setDatabases((prev) => prev.filter((d) => d.id !== db.id));
        setBannerNotice(`[DB] Database '${db.name}' removed.`);
      }
    } catch (err: any) {
      alert("Error deleting database: " + err.message);
    } finally {
      setTimeout(() => setBannerNotice(""), 3000);
    }
  };

  // Test database connection directly via auth.php
  const handleTestDbDirect = async (db: DatabaseItem) => {
    if (!db.linkedSiteId) {
      alert(`Database '${db.name}' has no linked target site environment.`);
      return;
    }
    setBannerNotice(`[TESTING] Probing MySQL connection on ${db.host}:${db.port}...`);
    try {
      const res = await fetch(`/api/sites/${db.linkedSiteId}/database/test`, { method: "POST" });
      const data = await res.json();
      if (data.success && data.connected) {
        setBannerNotice(
          `[SUCCESS] Connection verified for ${db.name}! Tables: ${data.details.table_count ?? 0} | Size: ${data.details.size_mb ? data.details.size_mb + " MB" : "N/A"} | Engine: ${data.details.mysql_version || "MySQL"}`
        );
        fetchData();
      } else {
        setBannerNotice(`[FAILED] MySQL Probe Failed: ${data.error || "Unable to establish connection"}`);
      }
    } catch (err: any) {
      setBannerNotice(`[ERROR] Connection test error: ${err.message}`);
    } finally {
      setTimeout(() => setBannerNotice(""), 6000);
    }
  };

  // Filtered sites
  const filteredSites = useMemo(() => {
    return sites.filter((site) => {
      const matchesStatus = statusFilter === "ALL" || site.status === statusFilter;
      const q = searchQuery.toLowerCase().trim();
      const matchesQuery =
        !q ||
        site.domain.toLowerCase().includes(q) ||
        site.repo.toLowerCase().includes(q) ||
        site.framework.toLowerCase().includes(q) ||
        site.path.toLowerCase().includes(q);
      return matchesStatus && matchesQuery;
    });
  }, [sites, searchQuery, statusFilter]);

  const onlineCount = sites.filter((s) => s.status === "ONLINE").length;

  return (
    <FuturisticLayout searchQuery={searchQuery} onSearchChange={setSearchQuery}>
      <div className="space-y-6">
        {bannerNotice && (
          <div className="p-3 bg-[#00f0ff]/15 border border-[#00f0ff] text-[#00f0ff] rounded-lg font-mono text-xs flex items-start gap-2 shadow-[0_0_15px_rgba(0,240,255,0.25)] animate-in fade-in">
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            <span className="min-w-0">{bannerNotice}</span>
          </div>
        )}

        {/* Action Header & View Switcher */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-base sm:text-xl font-mono font-extrabold text-white tracking-wider flex items-center gap-2">
              <Server className="w-5 h-5 shrink-0 text-[#00f0ff]" />
              <span className="min-w-0">SLATE DEVOPS OS &amp; CI/CD ORCHESTRATION</span>
            </h2>
            <p className="text-xs text-slate-400 font-mono">
              Persistent high-density deployment matrix &amp; multi-cluster management
            </p>
          </div>

          {/* Quick Action Buttons */}
          <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
            <button
              onClick={() => setIsProvisionDbOpen(true)}
              className="px-3 py-2 sm:px-3.5 rounded-lg bg-[#7000ff]/20 border border-[#7000ff] text-[#7000ff] hover:bg-[#7000ff] hover:text-white transition-all text-xs font-mono font-bold shadow-[0_0_15px_rgba(112,0,255,0.25)] flex items-center gap-1.5"
            >
              <Database className="w-3.5 h-3.5 shrink-0" /> Provision DB
            </button>
            <button
              onClick={() => setIsCreateRepoOpen(true)}
              className="px-3 py-2 sm:px-3.5 rounded-lg bg-[#7000ff]/20 border border-[#7000ff] text-[#7000ff] hover:bg-[#7000ff] hover:text-white transition-all text-xs font-mono font-bold shadow-[0_0_15px_rgba(112,0,255,0.3)] flex items-center gap-1.5"
            >
              <FolderPlus className="w-3.5 h-3.5 shrink-0" /> Scaffold ZIP
            </button>
            <button
              onClick={() => setIsAddSiteOpen(true)}
              className="px-3 py-2 sm:px-3.5 rounded-lg bg-[#00f0ff]/20 border border-[#00f0ff] text-[#00f0ff] hover:bg-[#00f0ff] hover:text-black transition-all text-xs font-mono font-bold shadow-[0_0_15px_rgba(0,240,255,0.25)] flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5 shrink-0" /> Add Target Domain
            </button>
          </div>
        </div>

        {/* View Navigation Tabs */}
        <div className="flex items-center gap-2 border-b border-[#1e293b] pb-2 font-mono text-xs overflow-x-auto -mx-1 px-1">
          <button
            onClick={() => handleTabChange("targets")}
            className={`px-3 sm:px-4 py-2 rounded-md font-bold transition-all flex items-center gap-2 shrink-0 whitespace-nowrap ${
              activeTab === "targets"
                ? "bg-[#00f0ff]/15 text-[#00f0ff] border border-[#00f0ff]/40 shadow-[0_0_10px_rgba(0,240,255,0.2)]"
                : "text-slate-400 hover:text-slate-200 hover:bg-[#111625]"
            }`}
          >
            <Server className="w-4 h-4" /> Target Environments ({sites.length})
          </button>
          <button
            onClick={() => handleTabChange("databases")}
            className={`px-3 sm:px-4 py-2 rounded-md font-bold transition-all flex items-center gap-2 shrink-0 whitespace-nowrap ${
              activeTab === "databases"
                ? "bg-[#7000ff]/20 text-[#7000ff] border border-[#7000ff]/40 shadow-[0_0_10px_rgba(112,0,255,0.2)]"
                : "text-slate-400 hover:text-slate-200 hover:bg-[#111625]"
            }`}
          >
            <Database className="w-4 h-4" /> Database Engine ({databases.length})
          </button>
          <button
            onClick={() => handleTabChange("logs")}
            className={`px-3 sm:px-4 py-2 rounded-md font-bold transition-all flex items-center gap-2 shrink-0 whitespace-nowrap ${
              activeTab === "logs"
                ? "bg-[#00f0ff]/15 text-[#00f0ff] border border-[#00f0ff]/40 shadow-[0_0_10px_rgba(0,240,255,0.2)]"
                : "text-slate-400 hover:text-slate-200 hover:bg-[#111625]"
            }`}
          >
            <Terminal className="w-4 h-4" /> CI/CD Deployment Logs ({deployments.length})
          </button>
          <button
            onClick={() => handleTabChange("telemetry")}
            className={`px-3 sm:px-4 py-2 rounded-md font-bold transition-all flex items-center gap-2 shrink-0 whitespace-nowrap ${
              activeTab === "telemetry"
                ? "bg-[#00f0ff]/15 text-[#00f0ff] border border-[#00f0ff]/40 shadow-[0_0_10px_rgba(0,240,255,0.2)]"
                : "text-slate-400 hover:text-slate-200 hover:bg-[#111625]"
            }`}
          >
            <Activity className="w-4 h-4" /> Cluster Telemetry
          </button>
        </div>

        {/* TAB 1: TARGETS MATRIX */}
        {activeTab === "targets" && (
          <div className="space-y-6">
            {/* Quick Metrics Bar */}
            <div className="grid grid-cols-1 xs:grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 font-mono text-xs">
              <div className="glass-panel p-4 rounded-xl border border-[#1e293b] min-w-0">
                <div className="text-slate-400 text-[11px]">ACTIVE TARGETS</div>
                <div className="text-lg sm:text-xl font-extrabold text-emerald-400 mt-1 flex items-center gap-2">
                  <span className="w-2 h-2 shrink-0 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="min-w-0">{onlineCount} / {sites.length} ONLINE</span>
                </div>
              </div>
              <div className="glass-panel p-4 rounded-xl border border-[#1e293b] min-w-0">
                <div className="text-slate-400 text-[11px]">MANAGED DATABASES</div>
                <div className="text-lg sm:text-xl font-extrabold text-[#7000ff] mt-1">{databases.length} PROVISIONED</div>
              </div>
              <div className="glass-panel p-4 rounded-xl border border-[#1e293b] min-w-0">
                <div className="text-slate-400 text-[11px]">TOTAL DEPLOYMENTS</div>
                <div className="text-lg sm:text-xl font-extrabold text-[#00f0ff] mt-1">{deployments.length} EXECUTED</div>
              </div>
              <div className="glass-panel p-4 rounded-xl border border-[#1e293b] min-w-0">
                <div className="text-slate-400 text-[11px]">DATA PERSISTENCE</div>
                <div className="text-lg sm:text-xl font-extrabold text-amber-400 mt-1 flex items-center gap-1.5">
                  <Shield className="w-4 h-4 shrink-0" /> <span className="min-w-0">ACTIVE (data/db.json)</span>
                </div>
              </div>
            </div>

            {/* Filter & Search Bar */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 font-mono text-xs">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-slate-400 shrink-0">Filter Status:</span>
                {["ALL", "ONLINE", "DEPLOYING", "OFFLINE"].map((st) => (
                  <button
                    key={st}
                    onClick={() => setStatusFilter(st)}
                    className={`px-2.5 py-1 rounded text-[11px] font-bold transition-colors shrink-0 ${
                      statusFilter === st
                        ? "bg-[#00f0ff]/20 text-[#00f0ff] border border-[#00f0ff]/40"
                        : "bg-[#111625] text-slate-400 border border-[#1e293b] hover:text-white"
                    }`}
                  >
                    {st}
                  </button>
                ))}
              </div>

              <div className="text-slate-400 text-[11px]">
                Showing {filteredSites.length} of {sites.length} target environments
              </div>
            </div>

            {/* High-Density Sites Matrix Table */}
            <div className="glass-panel rounded-xl border border-[#1e293b] overflow-hidden shadow-2xl">
              <div className="table-scroll">
                <table className="w-full text-left font-mono text-xs">
                <thead className="bg-[#0a0d14]/90 border-b border-[#1e293b] text-slate-400 uppercase text-[10px] tracking-wider">
                  <tr>
                    <th className="py-3.5 px-4">Status</th>
                    <th className="py-3.5 px-4">Target Domain & Remote Path</th>
                    <th className="py-3.5 px-4">App Stack</th>
                    <th className="py-3.5 px-4">Linked GitHub Repo</th>
                    <th className="py-3.5 px-4">Database</th>
                    <th className="py-3.5 px-4">Latency</th>
                    <th className="py-3.5 px-4 text-right">DevOps Operations</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1e293b]/60 text-slate-200">
                  {filteredSites.map((site) => {
                    const isExpanded = expandedDbSiteId === site.id;
                    const linkedDb = databases.find((d) => d.linkedSiteId === site.id) || null;
                    return (
                      <React.Fragment key={site.id}>
                        <tr className={`hover:bg-[#171f33]/80 transition-colors ${isExpanded ? "bg-[#111827]/95 border-l-2 border-l-[#7000ff]" : ""}`}>
                          <td className="py-4 px-4">
                            {site.status === "ONLINE" && (
                              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-[10px] font-bold">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> ONLINE
                              </span>
                            )}
                            {site.status === "DEPLOYING" && (
                              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/30 text-[10px] font-bold">
                                <RefreshCw className="w-3 h-3 animate-spin" /> DEPLOYING
                              </span>
                            )}
                            {site.status === "OFFLINE" && (
                              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/30 text-[10px] font-bold">
                                <XCircle className="w-3 h-3" /> OFFLINE
                              </span>
                            )}
                          </td>
                          <td className="py-4 px-4">
                            <a
                              href={site.domain}
                              target="_blank"
                              rel="noreferrer"
                              className="text-white font-semibold hover:text-[#00f0ff] flex items-center gap-1"
                            >
                              {site.domain} <ExternalLink className="w-3 h-3 shrink-0 text-slate-500" />
                            </a>
                            <div className="text-[11px] text-slate-500">{site.path}</div>
                          </td>
                          <td className="py-4 px-4">
                            <span className="px-2 py-1 rounded bg-slate-800 text-slate-300 border border-slate-700 text-[11px]">
                              {site.framework}
                            </span>
                          </td>
                          <td className="py-4 px-4">
                            <span className="text-[#7000ff] hover:underline cursor-pointer font-semibold">
                              {site.repo}
                            </span>
                            <div className="text-[10px] text-slate-500">SHA: {site.lastCommit}</div>
                          </td>
                          <td className="py-4 px-4">
                            <button
                              onClick={() => setExpandedDbSiteId(isExpanded ? null : site.id)}
                              className="group flex items-center gap-1 text-left hover:opacity-90 transition-opacity"
                              title="Toggle automated database & cPanel console"
                            >
                              <div className={`flex items-center gap-1.5 font-bold ${
                                site.dbStatus === "CONNECTED" ? "text-emerald-400" : "text-amber-400"
                              }`}>
                                <Database className="w-3.5 h-3.5 text-[#7000ff]" /> {site.dbStatus}
                                {isExpanded ? (
                                  <ChevronUp className="w-3 h-3 text-slate-400" />
                                ) : (
                                  <ChevronDown className="w-3 h-3 text-slate-500 group-hover:text-white" />
                                )}
                              </div>
                            </button>
                            <div className="text-[10px] text-slate-500 flex items-center gap-1.5 mt-0.5">
                              <span>{site.dbSize || "0 MB"}</span>
                              {site.cpanelLinked && (
                                <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#7000ff]/20 text-[#a855f7] border border-[#7000ff]/40 font-mono">
                                  cPanel
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="py-4 px-4 font-bold text-[#00f0ff]">
                            {site.latency}
                          </td>
                          <td className="py-4 px-4 text-right">
                            <div className="flex flex-wrap justify-end gap-1.5">
                            <button
                              onClick={() => handlePing(site.id)}
                              className="p-2 rounded bg-slate-800 hover:bg-[#00f0ff] hover:text-black border border-slate-700 transition-colors text-slate-300"
                              title="Ping & Check Latency"
                            >
                              <Wifi className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleRedeploy(site.id)}
                              className="p-2 rounded bg-slate-800 hover:bg-[#00f0ff] hover:text-black border border-slate-700 transition-colors text-slate-300"
                              title="Trigger Redeployment"
                            >
                              <RefreshCw className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => setExpandedDbSiteId(isExpanded ? null : site.id)}
                              className={`p-2 rounded border transition-colors ${
                                isExpanded
                                  ? "bg-[#7000ff] text-white border-[#7000ff] shadow-[0_0_12px_rgba(112,0,255,0.4)]"
                                  : "bg-slate-800 hover:bg-[#7000ff] hover:text-white border-slate-700 text-slate-300"
                              }`}
                              title="cPanel & MySQL Database Automation Console"
                            >
                              <Database className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => setTerminalTarget({ id: site.id, domain: site.domain })}
                              className="p-2 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 transition-colors text-slate-300 hover:text-white"
                              title="Inspect Live Deployment Logs"
                            >
                              <Terminal className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => setEditingSite(site)}
                              className="p-2 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 transition-colors text-slate-400 hover:text-white"
                              title="Edit Target Settings"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleDeleteSite(site)}
                              className="p-2 rounded bg-slate-800 hover:bg-rose-600 hover:text-white border border-slate-700 transition-colors text-slate-400"
                              title="Delete Target"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                            </div>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr className="bg-[#090d16] border-b border-[#7000ff]/30">
                            <td colSpan={7} className="p-4 md:p-6">
                              <div className="max-w-4xl mx-auto space-y-3">
                                <div className="flex flex-col sm:flex-row sm:items-center justify-between font-mono text-xs pb-2 border-b border-white/5 gap-2">
                                  <span className="text-[#00f0ff] font-bold flex items-center gap-2 min-w-0">
                                    <Database className="w-4 h-4 shrink-0 text-[#7000ff]" />
                                    <span className="min-w-0">AUTOMATED DATABASE &amp; CPANEL CONSOLE — {site.domain}</span>
                                  </span>
                                  <button
                                    onClick={() => setExpandedDbSiteId(null)}
                                    className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-[11px] font-mono transition-colors"
                                  >
                                    Close Console ✕
                                  </button>
                                </div>
                                <DatabasePanel
                                  siteId={site.id}
                                  siteDomain={site.domain}
                                  cpanelLinked={site.cpanelLinked}
                                  initialDb={linkedDb as any}
                                  onDatabaseUpdated={(newDb) => {
                                    setDatabases((prev) => {
                                      const exists = prev.some((d) => d.id === newDb.id || d.linkedSiteId === site.id);
                                      if (exists) {
                                        return prev.map((d) => (d.id === newDb.id || d.linkedSiteId === site.id ? newDb : d));
                                      }
                                      return [newDb, ...prev];
                                    });
                                    setSites((prev) =>
                                      prev.map((s) => (s.id === site.id ? { ...s, dbStatus: "CONNECTED" } : s))
                                    );
                                    setBannerNotice(`[DB STORED] Database credentials persisted for ${site.domain}`);
                                  }}
                                  onCpanelLinked={() => {
                                    setSites((prev) =>
                                      prev.map((s) => (s.id === site.id ? { ...s, cpanelLinked: true } : s))
                                    );
                                    setBannerNotice(`[CPANEL LINKED] cPanel API token authenticated on ${site.domain}`);
                                  }}
                                />
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                  {filteredSites.length === 0 && (
                    <tr>
                      <td colSpan={7} className="text-center py-8 text-slate-500">
                        No target environments match the search criteria. Click &quot;Add Target Domain&quot; to register one.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: DATABASES ENGINE */}
        {activeTab === "databases" && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-base font-mono font-bold text-white flex items-center gap-2">
                  <Database className="w-4 h-4 shrink-0 text-[#7000ff]" /> <span className="min-w-0">MANAGED DATABASE INSTANCES &amp; AUTOMATION</span>
                </h3>
                <p className="text-xs text-slate-400 font-mono">
                  cPanel UAPI automated provisioning, credential synchronization, schema probes &amp; user permissions
                </p>
              </div>
              <button
                onClick={() => setIsProvisionDbOpen(true)}
                className="px-3 sm:px-4 py-2 rounded bg-[#7000ff]/20 border border-[#7000ff] text-[#7000ff] hover:bg-[#7000ff] hover:text-white font-mono text-xs font-bold transition-all shadow-[0_0_15px_rgba(112,0,255,0.25)] flex items-center gap-2 self-start sm:self-auto shrink-0"
              >
                <Plus className="w-4 h-4 shrink-0" /> Manual / MySQL Provision
              </button>
            </div>

            {/* Interactive Automated cPanel & Database Controller */}
            {sites.length > 0 && (
              <div className="glass-panel p-5 rounded-2xl border border-[#7000ff]/30 shadow-2xl space-y-4 font-mono text-xs">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/5 pb-3">
                  <div className="min-w-0">
                    <h4 className="text-xs font-bold text-[#00f0ff] uppercase tracking-wider flex items-center gap-2">
                      <Database className="w-3.5 h-3.5 shrink-0 text-[#7000ff]" />
                      <span className="min-w-0">Live Site Database &amp; cPanel UAPI Controller</span>
                    </h4>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Select a live target site below to auto-provision, retrieve credentials, scan existing DBs, or probe PDO connection.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 max-w-full">
                    <span className="text-slate-400 text-xs font-mono shrink-0">Active Target:</span>
                    <select
                      value={selectedDbSiteId || (sites[0]?.id ?? "")}
                      onChange={(e) => setSelectedDbSiteId(e.target.value)}
                      className="flex-1 sm:flex-none min-w-0 bg-[#0b101e] border border-[#7000ff]/40 text-white text-xs rounded-lg px-3 py-1.5 font-mono focus:border-[#00f0ff] focus:outline-none"
                    >
                      {sites.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.domain} ({s.dbStatus})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {(() => {
                  const activeSite = sites.find((s) => s.id === (selectedDbSiteId || sites[0]?.id));
                  if (!activeSite) return null;
                  const activeDb = databases.find((d) => d.linkedSiteId === activeSite.id);
                  return (
                    <DatabasePanel
                      key={activeSite.id}
                      siteId={activeSite.id}
                      siteDomain={activeSite.domain}
                      cpanelLinked={activeSite.cpanelLinked}
                      initialDb={activeDb as any}
                      onDatabaseUpdated={(newDb) => {
                        setDatabases((prev) => {
                          const exists = prev.some((d) => d.id === newDb.id || d.linkedSiteId === activeSite.id);
                          if (exists) return prev.map((d) => (d.id === newDb.id || d.linkedSiteId === activeSite.id ? newDb : d));
                          return [newDb, ...prev];
                        });
                        setSites((prev) =>
                          prev.map((s) => (s.id === activeSite.id ? { ...s, dbStatus: "CONNECTED" } : s))
                        );
                        setBannerNotice(`[DB SAVED] Automated database configuration saved for ${activeSite.domain}`);
                      }}
                      onCpanelLinked={() => {
                        setSites((prev) =>
                          prev.map((s) => (s.id === activeSite.id ? { ...s, cpanelLinked: true } : s))
                        );
                        setBannerNotice(`[CPANEL LINKED] cPanel API token authenticated on ${activeSite.domain}`);
                      }}
                    />
                  );
                })()}
              </div>
            )}

            {/* Managed Database Instances Grid */}
            <div className="space-y-2">
              <div className="text-xs font-mono text-slate-400 uppercase tracking-wider font-bold">
                Stored Database Records ({databases.length})
              </div>
              <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                {databases.map((db) => {
                  const linkedSite = sites.find((s) => s.id === db.linkedSiteId);
                  return (
                    <div key={db.id} className="glass-panel p-5 rounded-xl border border-[#1e293b] space-y-3 font-mono text-xs">
                      <div className="flex items-center justify-between border-b border-[#1e293b] pb-2">
                        <span className="font-bold text-white text-sm flex items-center gap-1.5">
                          <Database className="w-4 h-4 text-[#7000ff]" /> {db.name}
                        </span>
                        <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-[10px] font-bold">
                          {db.status}
                        </span>
                      </div>

                      <div className="space-y-1.5 text-slate-300">
                        <div className="flex justify-between gap-2">
                          <span className="text-slate-500 shrink-0">Mode:</span>
                          <span className="font-bold uppercase text-[#7000ff] min-w-0">{db.mode}</span>
                        </div>
                        <div className="flex justify-between gap-2">
                          <span className="text-slate-500 shrink-0">User:</span>
                          <span className="min-w-0">{db.user}</span>
                        </div>
                        <div className="flex justify-between gap-2">
                          <span className="text-slate-500 shrink-0">Host:</span>
                          <span className="min-w-0">{db.host}:{db.port}</span>
                        </div>
                        <div className="flex justify-between gap-2">
                          <span className="text-slate-500 shrink-0">Allocated Size:</span>
                          <span className="text-[#00f0ff] font-bold shrink-0">{db.size}</span>
                        </div>
                        <div className="flex justify-between gap-2">
                          <span className="text-slate-500 shrink-0">Linked Site:</span>
                          <span className="text-white truncate min-w-0">
                            {linkedSite ? linkedSite.domain : "None"}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center justify-between pt-2 border-t border-[#1e293b]">
                        <button
                          onClick={() => handleTestDbDirect(db)}
                          className="text-[11px] text-[#00f0ff] hover:underline flex items-center gap-1"
                        >
                          <Radio className="w-3 h-3" /> Test Connection
                        </button>
                        <button
                          onClick={() => handleDeleteDb(db)}
                          className="text-slate-400 hover:text-rose-400 transition-colors p-1"
                          title="Remove Database Record"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: CI/CD DEPLOYMENT LOGS STREAM */}
        {activeTab === "logs" && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-base font-mono font-bold text-white flex items-center gap-2">
                  <Terminal className="w-4 h-4 shrink-0 text-[#00f0ff]" /> <span className="min-w-0">CONTINUOUS DEPLOYMENT PIPELINE RUNS</span>
                </h3>
                <p className="text-xs text-slate-400 font-mono">
                  Audit trail and console outputs from GitHub Actions, webhooks, and manual CLI triggers
                </p>
              </div>
              <button
                onClick={() => setTerminalTarget({ id: null, domain: "ALL TARGETS" })}
                className="px-3 sm:px-4 py-2 rounded bg-[#00f0ff]/20 border border-[#00f0ff] text-[#00f0ff] hover:bg-[#00f0ff] hover:text-black font-mono text-xs font-bold transition-all shadow-[0_0_15px_rgba(0,240,255,0.25)] flex items-center gap-2 self-start sm:self-auto shrink-0"
              >
                <Terminal className="w-4 h-4 shrink-0" /> Open Interactive CLI
              </button>
            </div>

            <div className="glass-panel rounded-xl border border-[#1e293b] overflow-hidden">
              <div className="divide-y divide-[#1e293b]/60 font-mono text-xs">
                {deployments.map((dep) => (
                  <div key={dep.id} className="p-4 hover:bg-[#111625]/80 transition-colors space-y-2">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div className="flex items-center gap-2 flex-wrap min-w-0">
                        <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-[10px] font-bold">
                          {dep.status}
                        </span>
                        <span className="font-bold text-white break-all">{dep.domain}</span>
                        <span className="text-slate-500 text-[11px] break-all">({dep.repo})</span>
                      </div>
                      <div className="flex items-center gap-3 text-slate-400 text-[11px] flex-wrap">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3 shrink-0 text-slate-500" /> {new Date(dep.timestamp).toLocaleTimeString()}
                        </span>
                        <span className="text-[#00f0ff] font-semibold">Duration: {dep.duration}</span>
                        <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 break-all">
                          SHA: {dep.commitSha}
                        </span>
                      </div>
                    </div>

                    <div className="bg-[#07090e] p-3 rounded-lg border border-[#1e293b] space-y-1 text-[11px] text-slate-400 overflow-x-auto">
                      {dep.logs.map((log, idx) => (
                        <div key={idx} className={log.includes("SUCCESS") || log.includes("ONLINE") ? "text-emerald-400" : ""}>
                          {log}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                {deployments.length === 0 && (
                  <div className="p-8 text-center text-slate-500">
                    No deployments recorded yet. Trigger a redeploy from Target Environments.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: TELEMETRY */}
        {activeTab === "telemetry" && (
          <div className="space-y-6">
            <div className="glass-panel rounded-xl p-5 border border-[#1e293b]">
              <div className="flex items-center justify-between mb-4 font-mono gap-2 flex-wrap">
                <div className="text-xs text-slate-300 flex items-center gap-2 min-w-0">
                  <Activity className="w-4 h-4 shrink-0 text-[#00f0ff]" /> <span className="min-w-0">CLUSTER LATENCY STREAM (LIVE FEED)</span>
                </div>
                <div className="text-xs font-mono text-[#00f0ff] font-bold shrink-0">AVG: 36.4 ms</div>
              </div>
              <div className="h-44 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={defaultTelemetryData}>
                    <defs>
                      <linearGradient id="cyanArea" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#00f0ff" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#00f0ff" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="time" stroke="#475569" fontSize={11} />
                    <YAxis stroke="#475569" fontSize={11} domain={[0, 80]} />
                    <Tooltip
                      contentStyle={{ backgroundColor: "#111625", borderColor: "#00f0ff", fontSize: "11px", color: "#fff" }}
                    />
                    <Area type="monotone" dataKey="latency" stroke="#00f0ff" fillOpacity={1} fill="url(#cyanArea)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 font-mono text-xs">
              <div className="glass-panel p-4 rounded-xl border border-[#1e293b] space-y-2">
                <div className="text-slate-400">NODE CPU UTILIZATION</div>
                <div className="text-2xl font-bold text-[#00f0ff]">14.2%</div>
                <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                  <div className="bg-[#00f0ff] h-full w-[14%]" />
                </div>
              </div>
              <div className="glass-panel p-4 rounded-xl border border-[#1e293b] space-y-2">
                <div className="text-slate-400">MEMORY UTILIZATION</div>
                <div className="text-2xl font-bold text-[#7000ff]">1.8 / 16 GB</div>
                <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                  <div className="bg-[#7000ff] h-full w-[22%]" />
                </div>
              </div>
              <div className="glass-panel p-4 rounded-xl border border-[#1e293b] space-y-2">
                <div className="text-slate-400">AGENT HANDSHAKE SUCCESS</div>
                <div className="text-2xl font-bold text-emerald-400">99.98%</div>
                <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                  <div className="bg-emerald-400 h-full w-[99%]" />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Modals & Drawers */}
      <AddSiteModal
        isOpen={isAddSiteOpen}
        onClose={() => setIsAddSiteOpen(false)}
        onAdded={(newSite) => {
          setSites((prev) => [newSite, ...prev]);
          setBannerNotice(`[REGISTERED] New target domain ${newSite.domain} configured.`);
        }}
      />

      <CreateRepoModal
        isOpen={isCreateRepoOpen}
        onClose={() => setIsCreateRepoOpen(false)}
        onSuccess={(created) => {
          fetchData();
          setBannerNotice(`[SCAFFOLDED] Repository created and registered as live target environment.`);
        }}
      />

      <EditSiteModal
        isOpen={!!editingSite}
        site={editingSite}
        onClose={() => setEditingSite(null)}
        onUpdated={(updated) => {
          setSites((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
          setBannerNotice(`[UPDATED] Settings saved for ${updated.domain}.`);
        }}
      />

      <ProvisionDbModal
        isOpen={isProvisionDbOpen}
        onClose={() => setIsProvisionDbOpen(false)}
        onProvisioned={(newDb) => {
          setDatabases((prev) => [newDb, ...prev]);
          fetchData(); // refresh sites to show new db link if selected
          setBannerNotice(`[DB PROVISIONED] ${newDb.name} ready and stored.`);
        }}
        sites={sites}
      />

      <TerminalDrawer
        isOpen={!!terminalTarget}
        onClose={() => setTerminalTarget(null)}
        siteId={terminalTarget?.id}
        siteDomain={terminalTarget?.domain}
      />
    </FuturisticLayout>
  );
}

export default function SitesDashboard() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#0a0d14] text-[#00f0ff] p-8 font-mono text-xs">Loading SLATE DevOps OS...</div>}>
      <SitesDashboardContent />
    </Suspense>
  );
}

