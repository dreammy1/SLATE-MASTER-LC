"use client";

import { useState, useCallback } from "react";
import CpanelSetupModal from "./CpanelSetupModal";

interface DbInfo {
  name: string;
  user: string;
  host: string;
  port: number;
  password?: string;
  size?: string;
  tablesCount?: number;
  status?: string;
  provisionedAt?: string | null;
  lastTested?: string | null;
}

interface ScanResult {
  databases: { name: string; size_mb: number | null }[];
  users: string[];
  counts: { databases: number; users: number };
}

type ProvisionStep =
  | "idle"
  | "checking_cpanel"
  | "creating_db"
  | "creating_user"
  | "granting"
  | "done"
  | "error";

const STEP_LABELS: Record<ProvisionStep, string> = {
  idle: "",
  checking_cpanel: "Connecting to cPanel UAPI…",
  creating_db: "Creating MySQL database…",
  creating_user: "Creating database user…",
  granting: "Granting ALL PRIVILEGES…",
  done: "Database provisioned!",
  error: "Provisioning failed",
};

const STEP_ORDER: ProvisionStep[] = [
  "checking_cpanel",
  "creating_db",
  "creating_user",
  "granting",
  "done",
];

interface DatabasePanelProps {
  siteId: string;
  siteDomain: string;
  cpanelLinked?: boolean;
  initialDb?: DbInfo | null;
  onDatabaseUpdated?: (newDb: any) => void;
  onCpanelLinked?: (user: string) => void;
}

export default function DatabasePanel({
  siteId,
  siteDomain,
  cpanelLinked: initialCpanelLinked = false,
  initialDb = null,
  onDatabaseUpdated,
  onCpanelLinked,
}: DatabasePanelProps) {
  const [db, setDb] = useState<DbInfo | null>(initialDb);
  const [cpanelLinked, setCpanelLinked] = useState(initialCpanelLinked);
  const [cpanelUser, setCpanelUser] = useState("");
  const [showCpanelModal, setShowCpanelModal] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const [provisionStep, setProvisionStep] = useState<ProvisionStep>("idle");
  const [provisionError, setProvisionError] = useState<string | null>(null);

  const [scanData, setScanData] = useState<ScanResult | null>(null);
  const [scanLoading, setScanLoading] = useState(false);

  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<{ connected: boolean; details?: any; error?: string } | null>(null);

  // ── Copy to clipboard ────────────────────────────────────────────────────
  const copyToClipboard = async (value: string, field: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {}
  };

  // ── cPanel linked callback ────────────────────────────────────────────────
  const handleCpanelLinked = (user: string) => {
    setCpanelLinked(true);
    setCpanelUser(user);
    setShowCpanelModal(false);
    onCpanelLinked?.(user);
  };

  // ── Scan existing databases ───────────────────────────────────────────────
  const handleScan = useCallback(async () => {
    setScanLoading(true);
    setScanData(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/database`);
      const data = await res.json();
      if (data.success) {
        setScanData(data.scan);
      }
    } catch {}
    setScanLoading(false);
  }, [siteId]);

  // ── Provision new database ────────────────────────────────────────────────
  const handleProvision = useCallback(async () => {
    if (!cpanelLinked) {
      setShowCpanelModal(true);
      return;
    }

    setProvisionStep("checking_cpanel");
    setProvisionError(null);

    try {
      const res = await fetch(`/api/sites/${siteId}/database`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create" }),
      });

      const data = await res.json();

      if (!data.success) {
        setProvisionStep("error");
        setProvisionError(data.error || "Unknown error");
        return;
      }

      // Animate through steps using the steps array from auth.php
      const serverSteps: string[] = (data.steps || []).map((s: any) => s.step);

      const stepMap: Record<string, ProvisionStep> = {
        create_database: "creating_db",
        create_user: "creating_user",
        grant_privileges: "granting",
      };

      for (const serverStep of serverSteps) {
        const uiStep = stepMap[serverStep];
        if (uiStep) {
          setProvisionStep(uiStep);
          await new Promise((r) => setTimeout(r, 600));
        }
      }

      setProvisionStep("done");

      const creds = data.credentials || {};
      const newDbInfo = {
        name: creds.db_name,
        user: creds.db_user,
        password: creds.db_password,
        host: creds.db_host || "localhost",
        port: creds.db_port || 3306,
        size: "0 MB",
        tablesCount: 0,
        status: "ACTIVE",
        provisionedAt: new Date().toISOString(),
      };
      setDb(newDbInfo);
      onDatabaseUpdated?.(data.savedDb || newDbInfo);
    } catch (err: any) {
      setProvisionStep("error");
      setProvisionError(err.message);
    }
  }, [siteId, cpanelLinked, onDatabaseUpdated]);

  // ── Test connection ───────────────────────────────────────────────────────
  const handleTest = useCallback(async () => {
    setTestLoading(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/database/test`, {
        method: "POST",
      });
      const data = await res.json();
      if (data.success) {
        setTestResult({ connected: data.connected, details: data.details, error: data.error });
        if (data.connected && db) {
          setDb((prev) =>
            prev
              ? {
                  ...prev,
                  size: data.details?.size_mb ? `${data.details.size_mb} MB` : prev.size,
                  tablesCount: data.details?.table_count ?? prev.tablesCount,
                  lastTested: new Date().toISOString(),
                }
              : prev
          );
        }
      } else {
        setTestResult({ connected: false, error: data.error });
      }
    } catch (err: any) {
      setTestResult({ connected: false, error: err.message });
    }
    setTestLoading(false);
  }, [siteId, db]);

  // ── Step progress bar ────────────────────────────────────────────────────
  const stepIndex = STEP_ORDER.indexOf(provisionStep);
  const progress =
    provisionStep === "idle" ? 0
    : provisionStep === "error" ? 100
    : Math.round(((stepIndex + 1) / STEP_ORDER.length) * 100);

  const isProvisioning = provisionStep !== "idle" && provisionStep !== "done" && provisionStep !== "error";

  return (
    <>
      {showCpanelModal && (
        <CpanelSetupModal
          siteId={siteId}
          siteDomain={siteDomain}
          onClose={() => setShowCpanelModal(false)}
          onSuccess={handleCpanelLinked}
        />
      )}

      <div
        className="rounded-2xl overflow-hidden"
        style={{ background: "rgba(15,23,42,0.8)", border: "1px solid rgba(99,102,241,0.2)" }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4"
          style={{
            background: "linear-gradient(135deg, rgba(99,102,241,0.15), rgba(139,92,246,0.1))",
            borderBottom: "1px solid rgba(99,102,241,0.15)",
          }}
        >
          <div className="flex items-center gap-3">
            <span className="text-xl">🗄️</span>
            <div>
              <p className="text-white font-semibold text-sm">Database</p>
              <p className="text-slate-400 text-xs">
                {cpanelLinked
                  ? `cPanel linked${cpanelUser ? ` · ${cpanelUser}` : ""}`
                  : "cPanel not linked"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* cPanel link status badge */}
            <span
              className="text-xs px-2 py-1 rounded-full font-medium"
              style={
                cpanelLinked
                  ? { background: "rgba(34,197,94,0.15)", color: "#4ade80", border: "1px solid rgba(34,197,94,0.3)" }
                  : { background: "rgba(234,179,8,0.1)", color: "#facc15", border: "1px solid rgba(234,179,8,0.3)" }
              }
            >
              {cpanelLinked ? "● cPanel Linked" : "⚪ Setup Required"}
            </span>

            {!cpanelLinked && (
              <button
                onClick={() => setShowCpanelModal(true)}
                className="text-xs px-3 py-1.5 rounded-lg font-medium text-white transition-all hover:opacity-90"
                style={{ background: "linear-gradient(135deg, #7c3aed, #4f46e5)" }}
              >
                Link cPanel
              </button>
            )}
          </div>
        </div>

        <div className="p-5 space-y-4">
          {/* DB credentials display */}
          {db ? (
            <div
              className="rounded-xl p-4 space-y-3"
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-slate-300 text-sm font-semibold">Database Credentials</span>
                <span
                  className="text-xs px-2 py-0.5 rounded-full"
                  style={
                    db.status === "ACTIVE"
                      ? { background: "rgba(34,197,94,0.15)", color: "#4ade80" }
                      : { background: "rgba(239,68,68,0.15)", color: "#f87171" }
                  }
                >
                  ● {db.status || "ACTIVE"}
                </span>
              </div>

              {[
                { label: "Database Name", value: db.name, field: "name" },
                { label: "Username", value: db.user, field: "user" },
                { label: "Host", value: db.host, field: "host" },
                { label: "Port", value: String(db.port || 3306), field: "port" },
              ].map(({ label, value, field }) => (
                <div key={field} className="flex items-center justify-between">
                  <span className="text-slate-400 text-xs w-32">{label}</span>
                  <div className="flex items-center gap-2 flex-1 justify-end">
                    <code className="text-slate-200 text-xs font-mono bg-black/20 px-2 py-0.5 rounded">
                      {value}
                    </code>
                    <button
                      onClick={() => copyToClipboard(value, field)}
                      className="text-xs text-slate-500 hover:text-purple-400 transition-colors"
                    >
                      {copiedField === field ? "✓" : "⎘"}
                    </button>
                  </div>
                </div>
              ))}

              {/* Password row */}
              {db.password && (
                <div className="flex items-center justify-between">
                  <span className="text-slate-400 text-xs w-32">Password</span>
                  <div className="flex items-center gap-2 flex-1 justify-end">
                    <code className="text-slate-200 text-xs font-mono bg-black/20 px-2 py-0.5 rounded">
                      {showPassword ? db.password : "••••••••••••••"}
                    </code>
                    <button
                      onClick={() => setShowPassword((v) => !v)}
                      className="text-xs text-slate-500 hover:text-indigo-400 transition-colors"
                    >
                      {showPassword ? "🙈" : "👁"}
                    </button>
                    <button
                      onClick={() => copyToClipboard(db.password!, "password")}
                      className="text-xs text-slate-500 hover:text-purple-400 transition-colors"
                    >
                      {copiedField === "password" ? "✓" : "⎘"}
                    </button>
                  </div>
                </div>
              )}

              {/* Stats row */}
              <div className="flex gap-4 pt-1 border-t border-white/5">
                <div className="text-center">
                  <p className="text-white text-sm font-bold">{db.tablesCount ?? 0}</p>
                  <p className="text-slate-500 text-xs">Tables</p>
                </div>
                <div className="text-center">
                  <p className="text-white text-sm font-bold">{db.size || "—"}</p>
                  <p className="text-slate-500 text-xs">Size</p>
                </div>
                {db.lastTested && (
                  <div className="text-center ml-auto">
                    <p className="text-slate-400 text-xs">Last tested</p>
                    <p className="text-slate-300 text-xs">{new Date(db.lastTested).toLocaleTimeString()}</p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div
              className="rounded-xl p-6 text-center"
              style={{ background: "rgba(255,255,255,0.02)", border: "1px dashed rgba(255,255,255,0.1)" }}
            >
              <p className="text-4xl mb-2">🗄️</p>
              <p className="text-slate-300 text-sm font-medium">No database provisioned yet</p>
              <p className="text-slate-500 text-xs mt-1">
                Click &quot;Provision Database&quot; to auto-create a MySQL database via cPanel
              </p>
            </div>
          )}

          {/* Provision progress */}
          {provisionStep !== "idle" && (
            <div
              className="rounded-xl p-4"
              style={{
                background:
                  provisionStep === "error"
                    ? "rgba(239,68,68,0.08)"
                    : provisionStep === "done"
                    ? "rgba(34,197,94,0.08)"
                    : "rgba(99,102,241,0.08)",
                border: `1px solid ${
                  provisionStep === "error"
                    ? "rgba(239,68,68,0.25)"
                    : provisionStep === "done"
                    ? "rgba(34,197,94,0.25)"
                    : "rgba(99,102,241,0.2)"
                }`,
              }}
            >
              <div className="flex items-center justify-between mb-2">
                <span
                  className="text-sm font-medium"
                  style={{
                    color:
                      provisionStep === "error" ? "#f87171"
                      : provisionStep === "done" ? "#4ade80"
                      : "#a5b4fc",
                  }}
                >
                  {provisionStep === "done" ? "✅ " : provisionStep === "error" ? "❌ " : "⚙️ "}
                  {STEP_LABELS[provisionStep]}
                </span>
                <span className="text-slate-400 text-xs">{progress}%</span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-white/10">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${progress}%`,
                    background:
                      provisionStep === "error"
                        ? "linear-gradient(90deg, #ef4444, #f97316)"
                        : provisionStep === "done"
                        ? "linear-gradient(90deg, #22c55e, #10b981)"
                        : "linear-gradient(90deg, #6366f1, #8b5cf6)",
                  }}
                />
              </div>
              {provisionError && (
                <p className="text-red-300 text-xs mt-2">{provisionError}</p>
              )}
            </div>
          )}

          {/* Test result */}
          {testResult && (
            <div
              className="rounded-xl p-3 text-sm"
              style={{
                background: testResult.connected ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)",
                border: `1px solid ${testResult.connected ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.25)"}`,
              }}
            >
              {testResult.connected ? (
                <div className="space-y-1">
                  <p className="text-green-400 font-semibold text-xs">✅ Connection Successful</p>
                  {testResult.details && (
                    <div className="grid grid-cols-1 xs:grid-cols-3 gap-2 mt-2">
                      <div>
                        <p className="text-slate-400 text-xs">Tables</p>
                        <p className="text-white text-xs font-bold">{testResult.details.table_count ?? "—"}</p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-xs">Size</p>
                        <p className="text-white text-xs font-bold">{testResult.details.size_mb ? `${testResult.details.size_mb} MB` : "—"}</p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-xs">MySQL</p>
                        <p className="text-white text-xs font-bold">{testResult.details.mysql_version?.split("-")[0] || "—"}</p>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-red-300 text-xs">❌ Connection failed: {testResult.error}</p>
              )}
            </div>
          )}

          {/* Scan result */}
          {scanData && (
            <div
              className="rounded-xl p-3"
              style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)" }}
            >
              <p className="text-slate-300 text-xs font-semibold mb-2">
                📋 Found {scanData.counts?.databases || 0} databases, {scanData.counts?.users || 0} users on server
              </p>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {(scanData.databases || []).map((d, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <code className="text-slate-300 text-xs font-mono">{d.name}</code>
                    {d.size_mb !== null && (
                      <span className="text-slate-500 text-xs">{d.size_mb} MB</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={handleProvision}
              disabled={isProvisioning}
              className="flex-1 min-w-[140px] py-2.5 rounded-xl text-white text-sm font-bold transition-all disabled:opacity-50 hover:opacity-90"
              style={{ background: "linear-gradient(135deg, #7c3aed, #4f46e5)" }}
            >
              {isProvisioning ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Provisioning…
                </span>
              ) : provisionStep === "done" ? (
                "🔄 Reprovision"
              ) : (
                "⚡ Provision Database"
              )}
            </button>

            {db && (
              <button
                onClick={handleTest}
                disabled={testLoading}
                className="px-4 py-2.5 rounded-xl text-slate-200 text-sm font-medium transition-all hover:text-white disabled:opacity-50"
                style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)" }}
              >
                {testLoading ? (
                  <span className="flex items-center gap-2">
                    <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Testing…
                  </span>
                ) : (
                  "🔍 Test Connection"
                )}
              </button>
            )}

            <button
              onClick={handleScan}
              disabled={scanLoading}
              className="px-4 py-2.5 rounded-xl text-slate-200 text-sm font-medium transition-all hover:text-white disabled:opacity-50"
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)" }}
            >
              {scanLoading ? (
                <span className="flex items-center gap-2">
                  <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Scanning…
                </span>
              ) : (
                "📋 Scan Databases"
              )}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
