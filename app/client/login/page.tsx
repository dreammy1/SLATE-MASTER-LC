"use client";
import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Mail, Shield, AlertCircle } from "lucide-react";

export default function ClientLoginPage() {
  const [licenseKey, setLicenseKey] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/client/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          license_key: licenseKey,
          email,
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        setError(data.error || "Login failed.");
      } else {
        router.push("/client/dashboard");
      }
    } catch (err: any) {
      setError(err?.message || "Network error.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0d14] text-slate-100 flex items-center justify-center font-mono p-4 sm:p-6 relative overflow-hidden">
      {/* Animated background */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute top-0 -left-1/2 w-96 h-96 bg-[#00f0ff]/5 rounded-full blur-3xl mix-blend-screen animate-pulse"></div>
        <div className="absolute bottom-0 -right-1/2 w-96 h-96 bg-cyan-500/5 rounded-full blur-3xl mix-blend-screen animate-pulse delay-1000"></div>
        <div className="absolute inset-0 opacity-[0.03]" style={{
          backgroundImage: `radial-gradient(#00f0ff 1px, transparent 1px)`,
          backgroundSize: "20px 20px",
        }}></div>
      </div>

      <div className="relative z-10 w-full max-w-md">
        <div className="bg-[#111625]/60 backdrop-blur border border-[#1e293b] rounded-xl p-5 sm:p-8">
          {/* Header */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-[#00f0ff]/10 border border-[#00f0ff]/30 mb-4">
              <Shield className="w-8 h-8 text-[#00f0ff]" />
            </div>
            <h1 className="text-2xl font-extrabold text-white">SLATE CLIENT PORTAL</h1>
            <p className="text-slate-400 text-xs mt-1">License Holder Login</p>
          </div>

          {/* Error message */}
          {error && (
            <div className="mb-4 p-3 bg-rose-900/30 border border-rose-500/50 rounded-lg text-rose-300 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          {/* Login form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* License Key */}
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">License Key</label>
              <div className="relative">
                <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <input
                  type="text"
                  value={licenseKey}
                  onChange={(e) => setLicenseKey(e.target.value.toUpperCase())}
                  className="w-full pl-10 pr-3 py-2.5 text-sm bg-[#0a0d14] border border-[#1e293b] rounded-lg text-white placeholder-slate-600 font-mono focus:outline-none focus:border-[#00f0ff]/50 focus:ring-1 focus:ring-[#00f0ff]/20 transition-colors"
                  placeholder="SLT-XXXX-XXXX-XXXX-XXXX"
                  required
                  disabled={submitting}
                  maxLength={24}
                />
              </div>
              <p className="text-xs text-slate-500 mt-1">Enter your SLT- license key</p>
            </div>

            {/* Email */}
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Registered Email</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-10 pr-3 py-2.5 text-sm bg-[#0a0d14] border border-[#1e293b] rounded-lg text-white placeholder-slate-600 focus:outline-none focus:border-[#00f0ff]/50 focus:ring-1 focus:ring-[#00f0ff]/20 transition-colors"
                  placeholder="name@company.com"
                  required
                  disabled={submitting}
                />
              </div>
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 px-4 text-sm font-bold rounded-lg bg-gradient-to-r from-[#00f0ff] to-[#00a8ff] text-[#0a0d14] hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {submitting ? (
                <>
                  <div className="w-4 h-4 border-2 border-[#0a0d14] border-t-transparent rounded-full animate-spin"></div>
                  Authenticating...
                </>
              ) : (
                "ACCESS LICENSE DASHBOARD"
              )}
            </button>
          </form>
        </div>

        {/* Footer */}
        <div className="text-center mt-6 text-slate-500 text-xs">
          <p>Client Self-Service Portal — Your license & site dashboard</p>
        </div>
      </div>
    </div>
  );
}
