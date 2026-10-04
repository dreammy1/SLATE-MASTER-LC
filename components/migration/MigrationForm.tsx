"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Database,
  Download,
  FileDown,
  FolderSync,
  Layers,
  Link2,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { MigrationJob, ServerEndpoint } from "./types";
import { getAuthAgentUrl } from "@/lib/migrationPaths";

interface SiteOption {
  id: string;
  domain: string;
  path: string;
  framework: string;
}

interface DatabaseOption {
  id: string;
  name: string;
  user: string;
  password?: string;
  host: string;
  port: number;
  linkedSiteId: string | null;
}

interface Props {
  onSave: (payload: any) => void;
  onCancel: () => void;
  initialJob?: MigrationJob | null;
  sites?: SiteOption[];
  databases?: DatabaseOption[];
}

const emptyEndpoint = (role: "source" | "target", index = 1): ServerEndpoint => ({
  serverName: role === "source" ? "Source Server (Export)" : `Import Target ${index}`,
  cpanelHost: "",
  cpanelPort: 2083,
  cpanelUser: "",
  cpanelApiToken: "",
  fileManagerPath: "/public_html",
  siteUrl: "",
  dbHost: "localhost",
  dbName: "",
  dbUser: "",
  dbPass: "",
});

function endpointKey(role: "source" | "target", targetIndex = 0): string {
  return role === "source" ? "source" : `target_${targetIndex}`;
}

function hostnameFromUrl(value: string) {
  try {
    return new URL(value).hostname;
  } catch {
    return value.replace(/^https?:\/\//, "").split("/")[0];
  }
}

function userFromPath(value: string) {
  const match = value.match(/\/home\/([^/]+)/);
  return match?.[1] || "";
}

function applySite(endpoint: ServerEndpoint, site?: SiteOption): ServerEndpoint {
  if (!site) return endpoint;
  const host = hostnameFromUrl(site.domain);
  const pathUser = userFromPath(site.path);

  return {
    ...endpoint,
    serverName: `${site.framework || "Site"} - ${host}`,
    cpanelHost: endpoint.cpanelHost || host,
    cpanelUser: endpoint.cpanelUser || pathUser,
    fileManagerPath: site.path || endpoint.fileManagerPath,
    siteUrl: site.domain,
  };
}

function applyDatabase(endpoint: ServerEndpoint, database?: DatabaseOption): ServerEndpoint {
  if (!database) return endpoint;

  return {
    ...endpoint,
    dbHost: database.host || endpoint.dbHost,
    dbName: database.name,
    dbUser: database.user,
    dbPass: database.password || endpoint.dbPass,
  };
}

function buildAuthPhpUrl(siteUrl?: string, filePath?: string): string {
  return getAuthAgentUrl(siteUrl, filePath);
}

export default function MigrationForm({ onSave, onCancel, initialJob, sites = [], databases = [] }: Props) {
  const [title, setTitle] = useState(initialJob?.title || "Server-to-Server Live Clone");
  const [source, setSource] = useState<ServerEndpoint>(initialJob?.source || emptyEndpoint("source"));
  const [targets, setTargets] = useState<ServerEndpoint[]>(
    initialJob?.targets?.length ? initialJob.targets : [initialJob?.destination || emptyEndpoint("target")]
  );
  const [options, setOptions] = useState(
    initialJob?.options || {
      syncFiles: true,
      syncDatabase: true,
      replaceDomainUrls: true,
      fixFilePermissions: true,
    }
  );
  const [testing, setTesting] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<Record<string, any>>({});
  const [selectedSiteIds, setSelectedSiteIds] = useState<Record<string, string>>({});
  const [selectedDbIds, setSelectedDbIds] = useState<Record<string, string>>({});

  useEffect(() => {
    setTitle(initialJob?.title || "Server-to-Server Live Clone");
    setSource(initialJob?.source || emptyEndpoint("source"));
    setTargets(initialJob?.targets?.length ? initialJob.targets : [initialJob?.destination || emptyEndpoint("target")]);
    setOptions(
      initialJob?.options || {
        syncFiles: true,
        syncDatabase: true,
        replaceDomainUrls: true,
        fixFilePermissions: true,
      }
    );
    setConnectionStatus({});
    setSelectedSiteIds({});
    setSelectedDbIds({});
  }, [initialJob]);

  const dbBySiteId = useMemo(() => {
    return databases.reduce<Record<string, DatabaseOption>>((acc, database) => {
      if (database.linkedSiteId) acc[database.linkedSiteId] = database;
      return acc;
    }, {});
  }, [databases]);

  const updateTarget = (index: number, patch: Partial<ServerEndpoint>) => {
    setTargets((prev) => prev.map((target, i) => (i === index ? { ...target, ...patch } : target)));
  };

  const handleSelectSite = (role: "source" | "target", siteId: string, targetIndex = 0) => {
    const key = endpointKey(role, targetIndex);
    setSelectedSiteIds((prev) => ({ ...prev, [key]: siteId }));

    const site = sites.find((item) => item.id === siteId);
    const linkedDb = site ? dbBySiteId[site.id] : undefined;
    if (linkedDb) {
      setSelectedDbIds((prev) => ({ ...prev, [key]: linkedDb.id }));
    }

    if (role === "source") {
      setSource((prev) => applyDatabase(applySite(prev, site), linkedDb));
      return;
    }

    setTargets((prev) =>
      prev.map((target, index) => (index === targetIndex ? applyDatabase(applySite(target, site), linkedDb) : target))
    );
  };

  const handleSelectDatabase = (role: "source" | "target", databaseId: string, targetIndex = 0) => {
    const key = endpointKey(role, targetIndex);
    setSelectedDbIds((prev) => ({ ...prev, [key]: databaseId }));

    const database = databases.find((item) => item.id === databaseId);

    if (role === "source") {
      setSource((prev) => applyDatabase(prev, database));
      return;
    }

    setTargets((prev) => prev.map((target, index) => (index === targetIndex ? applyDatabase(target, database) : target)));
  };

  const handleTest = async (key: string, endpoint: ServerEndpoint) => {
    setTesting(key);
    try {
      const res = await fetch("/api/migrations/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
      const data = await res.json();
      setConnectionStatus((prev) => ({ ...prev, [key]: data }));
    } catch (err: any) {
      setConnectionStatus((prev) => ({ ...prev, [key]: { success: false, message: err.message || "Network error during test" } }));
    } finally {
      setTesting(null);
    }
  };

  const handleDownloadAuthPhp = async (_endpoint: ServerEndpoint, _key: string) => {
    try {
      const res = await fetch("/api/migrations/auth-php", { method: "GET" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "auth.php";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      alert("Failed to download auth.php: " + (err?.message || err));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      id: initialJob?.id,
      title,
      source,
      destination: targets[0],
      targets,
      options,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="glass-panel rounded-xl p-6 border border-[#00f0ff]/40 space-y-6 font-mono text-xs animate-in fade-in">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b border-[#1e293b] pb-3">
        <span className="font-bold text-slate-200 text-sm flex items-center gap-2">
          <Layers className="w-4 h-4 text-[#00f0ff]" />
          {initialJob ? "EDIT MIGRATION BRIDGE" : "STAGE NEW MIGRATION BRIDGE"}
        </span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Migration Title"
          className="bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white text-xs w-full lg:w-96 focus:outline-none focus:border-[#00f0ff]"
          required
        />
      </div>

      <EndpointPanel
        title="1. EXPORT SOURCE"
        tone="source"
        endpoint={source}
        status={connectionStatus.source}
        isTesting={testing === "source"}
        sites={sites}
        databases={databases}
        selectedSiteId={selectedSiteIds.source || ""}
        selectedDbId={selectedDbIds.source || ""}
        onSelectSite={(siteId) => handleSelectSite("source", siteId)}
        onSelectDatabase={(databaseId) => handleSelectDatabase("source", databaseId)}
        onChange={(patch) => setSource((prev) => ({ ...prev, ...patch }))}
        onTest={() => handleTest("source", source)}
        onDownloadAuthPhp={() => handleDownloadAuthPhp(source, "source")}
      />

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="font-bold text-[#00f0ff] flex items-center gap-2">
            <Link2 className="w-4 h-4" />
            IMPORT TARGET GRID ({targets.length})
          </span>
          <button
            type="button"
            onClick={() => setTargets((prev) => [...prev, emptyEndpoint("target", prev.length + 1)])}
            className="px-3 py-2 rounded bg-[#00f0ff]/20 border border-[#00f0ff] text-[#00f0ff] hover:bg-[#00f0ff] hover:text-black transition-colors font-bold flex items-center gap-2"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Import Target
          </button>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {targets.map((target, index) => (
            <EndpointPanel
              key={index}
              title={`${index + 1}. IMPORT TARGET`}
              tone="target"
              endpoint={target}
              status={connectionStatus[`target_${index}`]}
              isTesting={testing === `target_${index}`}
              sites={sites}
              databases={databases}
              selectedSiteId={selectedSiteIds[`target_${index}`] || ""}
              selectedDbId={selectedDbIds[`target_${index}`] || ""}
              onSelectSite={(siteId) => handleSelectSite("target", siteId, index)}
              onSelectDatabase={(databaseId) => handleSelectDatabase("target", databaseId, index)}
              onChange={(patch) => updateTarget(index, patch)}
              onTest={() => handleTest(`target_${index}`, target)}
              onDownloadAuthPhp={() => handleDownloadAuthPhp(target, `target_${index}`)}
              onRemove={targets.length > 1 ? () => setTargets((prev) => prev.filter((_, i) => i !== index)) : undefined}
            />
          ))}
        </div>
      </div>

      <div className="p-4 rounded-lg bg-[#111625] border border-[#1e293b] flex flex-wrap items-center justify-between gap-4 text-[11px]">
        <Toggle checked={options.syncFiles} label="Synchronize All Files & Uploads" onChange={(checked) => setOptions({ ...options, syncFiles: checked })} />
        <Toggle checked={options.syncDatabase} label="Export & Import Full Database" onChange={(checked) => setOptions({ ...options, syncDatabase: checked })} />
        <Toggle checked={options.replaceDomainUrls} label="Search-and-Replace Domain URLs in DB" onChange={(checked) => setOptions({ ...options, replaceDomainUrls: checked })} />
        <Toggle checked={options.fixFilePermissions} label="Auto-Fix Permissions (0755/0644)" onChange={(checked) => setOptions({ ...options, fixFilePermissions: checked })} />
      </div>

      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded bg-slate-800 text-slate-300 hover:bg-slate-700">
          Cancel
        </button>
        <button
          type="submit"
          className="px-6 py-2 rounded bg-[#00f0ff]/20 border border-[#00f0ff] text-[#00f0ff] hover:bg-[#00f0ff] hover:text-black font-bold shadow-[0_0_15px_rgba(0,240,255,0.25)] transition-all flex items-center gap-2"
        >
          <FolderSync className="w-4 h-4" />
          {initialJob ? "Save Bridge Changes" : "Save & Stage Migration Plan"}
        </button>
      </div>
    </form>
  );
}

function EndpointPanel({
  title,
  tone,
  endpoint,
  status,
  isTesting,
  sites,
  databases,
  selectedSiteId,
  selectedDbId,
  onSelectSite,
  onSelectDatabase,
  onChange,
  onTest,
  onDownloadAuthPhp,
  onRemove,
}: {
  title: string;
  tone: "source" | "target";
  endpoint: ServerEndpoint;
  status?: any;
  isTesting: boolean;
  sites: SiteOption[];
  databases: DatabaseOption[];
  selectedSiteId: string;
  selectedDbId: string;
  onSelectSite: (siteId: string) => void;
  onSelectDatabase: (databaseId: string) => void;
  onChange: (patch: Partial<ServerEndpoint>) => void;
  onTest: () => void;
  onDownloadAuthPhp: () => void;
  onRemove?: () => void;
}) {
  const accent = tone === "source" ? "text-amber-400" : "text-[#00f0ff]";
  const agentUrl = buildAuthPhpUrl(endpoint.siteUrl, endpoint.fileManagerPath);

  return (
    <div className="p-4 rounded-lg bg-[#0a0d14]/70 border border-[#1e293b] space-y-3">
      <div className="flex items-center justify-between gap-3 border-b border-[#1e293b] pb-2">
        <span className={`font-bold flex items-center gap-2 ${accent}`}>
          <Server className="w-4 h-4" />
          {title}
        </span>
        <div className="flex items-center gap-2">
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              className="p-2 rounded bg-rose-500/10 border border-rose-500/30 text-rose-400 hover:bg-rose-500 hover:text-black"
              title="Remove import target"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={onDownloadAuthPhp}
            className="px-2.5 py-2 rounded bg-indigo-500/20 hover:bg-indigo-500 hover:text-black border border-indigo-400/40 text-indigo-300 transition-colors flex items-center gap-1.5 text-[11px]"
            title="Download auth.php agent file - upload this to the server folder path below"
          >
            <FileDown className="w-3 h-3" />
            Get auth.php
          </button>
          <button
            type="button"
            onClick={onTest}
            disabled={isTesting}
            className="px-2.5 py-2 rounded bg-slate-800 hover:bg-[#00f0ff] hover:text-black border border-slate-700 transition-colors flex items-center gap-1.5 text-[11px] disabled:opacity-60"
          >
            {isTesting ? <RefreshCw className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3 text-[#00f0ff]" />}
            Test
          </button>
        </div>
      </div>

      <div className="p-3 rounded border border-indigo-500/30 bg-indigo-500/5 space-y-1 text-[11px]">
        <div className="flex items-start gap-2">
          <Download className="w-3.5 h-3.5 text-indigo-400 mt-0.5 flex-shrink-0" />
          <div className="space-y-0.5">
            <div className="text-indigo-300 font-semibold">
              MANDATORY: Upload <code className="bg-black/40 px-1 rounded text-indigo-200">auth.php</code> to this path:
            </div>
            <div className="font-mono break-all text-slate-200">
              <span className="text-slate-500">Folder: </span>
              <span className="text-white">{endpoint.fileManagerPath || "/public_html"}</span>
              {agentUrl && (
                <>
                  <span className="text-slate-500"> &nbsp;•&nbsp; Agent URL: </span>
                  <a href={agentUrl} target="_blank" rel="noreferrer" className="text-indigo-300 underline hover:text-indigo-200">{agentUrl}</a>
                </>
              )}
            </div>
            <div className="text-slate-500">
              Click &quot;Get auth.php&quot; above to download the latest agent. After upload, click &quot;Test&quot; to verify reachability.
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3 rounded bg-[#111625] border border-[#1e293b]">
        <SelectField label="Use Existing Site" value={selectedSiteId} onChange={onSelectSite}>
          <option value="">Select from target sites</option>
          {sites.map((site) => (
            <option key={site.id} value={site.id}>
              {site.domain} - {site.path}
            </option>
          ))}
        </SelectField>
        <SelectField label="Use Existing Database" value={selectedDbId} onChange={onSelectDatabase}>
          <option value="">Select from databases</option>
          {databases.map((database) => (
            <option key={database.id} value={database.id}>
              {database.name} - {database.user}
            </option>
          ))}
        </SelectField>
      </div>

      {status && (
        <div className={`p-2.5 rounded border text-[11px] ${status.success ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-400" : "bg-rose-500/10 border-rose-500/40 text-rose-400"}`}>
          <div className="font-bold flex items-center gap-1">
            {status.success ? <CheckCircle2 className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
            {status.message}
          </div>
          {status.details?.agentUrl && (
            <div className="text-[10px] opacity-80 mt-1">Agent: {status.details.agentUrl}</div>
          )}
          {status.remediation && (
            <div className="mt-1.5 pt-1.5 border-t border-current/20 text-[10px] text-amber-300">
              <span className="font-bold uppercase tracking-wide">Action required: </span>
              {status.remediation}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <TextField label="Server Label" value={endpoint.serverName} onChange={(value) => onChange({ serverName: value })} required />
        <TextField label="cPanel Host / IP" value={endpoint.cpanelHost} onChange={(value) => onChange({ cpanelHost: value })} required />
        <TextField label="cPanel Username" value={endpoint.cpanelUser} onChange={(value) => onChange({ cpanelUser: value })} required />
        <TextField label="cPanel Port" type="number" value={String(endpoint.cpanelPort || 2083)} onChange={(value) => onChange({ cpanelPort: Number(value) || 2083 })} />
      </div>

      <TextField label="cPanel API Token / Password" type="password" value={endpoint.cpanelApiToken} onChange={(value) => onChange({ cpanelApiToken: value })} required />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <TextField label="File Manager Path" value={endpoint.fileManagerPath} onChange={(value) => onChange({ fileManagerPath: value })} required />
        <TextField label="Site URL" type="url" value={endpoint.siteUrl} onChange={(value) => onChange({ siteUrl: value })} required />
      </div>

      <div className="border-t border-[#1e293b] pt-3">
        <div className="text-[11px] font-bold text-slate-300 mb-2 flex items-center gap-1">
          <Database className={`w-3 h-3 ${accent}`} />
          Database Bridge: {endpoint.dbName || "(not selected)"}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <TextField label="DB Host" value={endpoint.dbHost} onChange={(value) => onChange({ dbHost: value })} />
          <TextField label="DB Name" value={endpoint.dbName} onChange={(value) => onChange({ dbName: value })} />
          <TextField label="DB User" value={endpoint.dbUser} onChange={(value) => onChange({ dbUser: value })} />
          <TextField label="DB Pass" type="password" value={endpoint.dbPass} onChange={(value) => onChange({ dbPass: value })} />
        </div>
      </div>
    </div>
  );
}

function TextField({ label, value, onChange, type = "text", required = false }: { label: string; value: string; onChange: (value: string) => void; type?: string; required?: boolean }) {
  return (
    <label className="block">
      <span className="text-slate-400 block mb-0.5">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-[#111625] border border-[#1e293b] rounded px-2.5 py-1.5 text-white focus:outline-none focus:border-[#00f0ff]"
        required={required}
      />
    </label>
  );
}

function SelectField({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-slate-400 block mb-0.5">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-[#00f0ff]"
      >
        {children}
      </select>
    </label>
  );
}

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-[#00f0ff]" />
      <span className="text-slate-300">{label}</span>
    </label>
  );
}
