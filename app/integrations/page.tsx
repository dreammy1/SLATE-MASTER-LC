"use client";
import { useState, useEffect } from "react";
import { CreditCard, Mail, TestTube, Save, RefreshCw, AlertCircle } from "lucide-react";
import FuturisticLayout from "@/components/FuturisticLayout";

export default function IntegrationsPage() {
  const [activeTab, setActiveTab] = useState<"stripe" | "smtp">("stripe");
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, any>>({});
  const [stripe, setStripe] = useState({ secret_key: "", webhook_secret: "" });
  const [smtp, setSmtp] = useState({ host: "", port: "587", user: "", pass: "", from: "licensing@yourdomain.com", encryption: "tls", test_email_to: "" });
  const [smtpStatus, setSmtpStatus] = useState({ configured: false, tested: false });
  const [stripeStatus, setStripeStatus] = useState({ connected: false });

  useEffect(() => {
    fetch("/api/integrations/stripe").then(r => r.json()).then(data => { if (data.stripe) setStripeStatus(data.stripe); });
    fetch("/api/integrations/smtp").then(r => r.json()).then(data => { if (data.smtp) setSmtpStatus(data.smtp); });
  }, []);

  const handleStripeTest = async () => {
    setLoading({ ...loading, stripeTest: true });
    try {
      const res = await fetch("/api/integrations/stripe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "test_connection", stripe_secret_key: stripe.secret_key }) });
      const data = await res.json();
      setResults({ ...results, stripeTest: data });
      if (data.success) setStripeStatus({ ...stripeStatus, connected: true });
    } catch (e) { setResults({ ...results, stripeTest: { success: false, error: "Network error" } }); }
    finally { setLoading({ ...loading, stripeTest: false }); }
  };

  const handleSmtpTest = async () => {
    setLoading({ ...loading, smtpTest: true });
    try {
      const res = await fetch("/api/integrations/smtp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "test_connection", ...smtp }) });
      const data = await res.json();
      setResults({ ...results, smtpTest: data });
      if (data.success) setSmtpStatus({ ...smtpStatus, tested: true });
    } catch (e) { setResults({ ...results, smtpTest: { success: false, error: "Network error" } }); }
    finally { setLoading({ ...loading, smtpTest: false }); }
  };

  const handleStripeSave = async () => {
    setLoading({ ...loading, stripeSave: true });
    try {
      const res = await fetch("/api/integrations/stripe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "configure", stripe_secret_key: stripe.secret_key, stripe_webhook_secret: stripe.webhook_secret }) });
      const data = await res.json();
      setResults({ ...results, stripeSave: data });
      if (data.success) setStripeStatus({ ...stripeStatus, connected: true });
    } catch (e) { setResults({ ...results, stripeSave: { success: false, error: "Network error" } }); }
    finally { setLoading({ ...loading, stripeSave: false }); }
  };

  const handleSmtpSendTest = async () => {
    setLoading({ ...loading, smtpSend: true });
    try {
      const res = await fetch("/api/integrations/smtp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "send_test_email", ...smtp }) });
      const data = await res.json();
      setResults({ ...results, smtpSend: data });
    } catch (e) { setResults({ ...results, smtpSend: { success: false, error: "Network error" } }); }
    finally { setLoading({ ...loading, smtpSend: false }); }
  };

  const handleSmtpSave = async () => {
    setLoading({ ...loading, smtpSave: true });
    try {
      const res = await fetch("/api/integrations/smtp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "configure", smtp_host: smtp.host, smtp_port: smtp.port, smtp_user: smtp.user, smtp_pass: smtp.pass, smtp_from: smtp.from, smtp_encryption: smtp.encryption }) });
      const data = await res.json();
      setResults({ ...results, smtpSave: data });
      if (data.success) setSmtpStatus({ ...smtpStatus, configured: true });
    } catch (e) { setResults({ ...results, smtpSave: { success: false, error: "Network error" } }); }
    finally { setLoading({ ...loading, smtpSave: false }); }
  };

  const StatusBadge = ({ status }: { status: boolean }) => (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-mono ${status ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30" : "bg-slate-500/10 text-slate-500 border border-slate-700"}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${status ? "bg-emerald-400 animate-pulse" : "bg-slate-500"}`} />
      {status ? "ACTIVE" : "INACTIVE"}
    </span>
  );

  const ResultBanner = ({ keyName }: { keyName: string }) => {
    const r = results[keyName];
    if (!r) return null;
    return <div className={`mt-3 p-3 rounded-md border font-mono text-sm ${r.success ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300" : "bg-rose-500/10 border-rose-500/30 text-rose-300"}`}>{r.message || r.error}</div>;
  };

  return (
    <FuturisticLayout activeTab="integrations">
    <div className="space-y-6 font-mono text-xs">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold font-mono text-white">INTEGRATIONS</h1>
          <p className="text-slate-400 text-sm font-mono mt-1">THIRD-PARTY SERVICE CONNECTOR</p>
        </div>
      </div>

      <div className="flex gap-2 border-b border-[#1e293b] overflow-x-auto -mx-1 px-1">
        <button onClick={() => setActiveTab("stripe")} className={`px-4 py-2 font-mono text-sm transition-all flex items-center gap-2 shrink-0 whitespace-nowrap ${activeTab === "stripe" ? "text-[#00f0ff] border-b-2 border-[#00f0ff]" : "text-slate-400 hover:text-slate-300"}`}>
          <CreditCard className="w-4 h-4 shrink-0" /> Stripe
        </button>
        <button onClick={() => setActiveTab("smtp")} className={`px-4 py-2 font-mono text-sm transition-all flex items-center gap-2 shrink-0 whitespace-nowrap ${activeTab === "smtp" ? "text-[#00f0ff] border-b-2 border-[#00f0ff]" : "text-slate-400 hover:text-slate-300"}`}>
          <Mail className="w-4 h-4 shrink-0" /> SMTP / Email
        </button>
      </div>

      {activeTab === "stripe" && (
        <div className="grid gap-6">
          <div className="glass-panel p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-[#0a0d14]/60 border border-[#1e293b]">
                <CreditCard className="w-5 h-5 text-[#00f0ff]" />
              </div>
              <div>
                <p className="font-mono text-sm text-slate-400">Stripe Connection</p>
                <p className="font-mono font-bold text-white">{stripeStatus.connected ? "Connected" : "Not Connected"}</p>
              </div>
            </div>
            <StatusBadge status={stripeStatus.connected} />
          </div>

          <div className="glass-panel p-5 space-y-4">
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-mono text-slate-500 mb-1">Secret Key</label>
                <input type="password" value={stripe.secret_key} onChange={(e) => setStripe({ ...stripe, secret_key: e.target.value })} className="w-full bg-[#0a0d14]/80 border border-[#1e293b] text-slate-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#00f0ff]" placeholder="sk_live_... or sk_test_..." />
                <p className="text-[10px] text-slate-600 mt-1 font-mono">Found in Stripe Dashboard - Developers - API keys</p>
              </div>
              <div>
                <label className="block text-xs font-mono text-slate-500 mb-1">Webhook Signing Secret</label>
                <input type="password" value={stripe.webhook_secret} onChange={(e) => setStripe({ ...stripe, webhook_secret: e.target.value })} className="w-full bg-[#0a0d14]/80 border border-[#1e293b] text-slate-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#00f0ff]" placeholder="whsec_..." />
                <p className="text-[10px] text-slate-600 mt-1 font-mono">From Stripe Dashboard - Developers - Webhooks</p>
              </div>
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 pt-3 border-t border-[#1e293b]">
                <button onClick={handleStripeTest} disabled={loading.stripeTest} className="px-3 sm:px-4 py-2 bg-[#0a0d14]/60 border border-[#1e293b] text-slate-300 rounded-md hover:border-[#00f0ff] hover:text-[#00f0ff] font-mono text-sm transition-all flex items-center justify-center gap-2 disabled:opacity-50">
                  {loading.stripeTest ? <RefreshCw className="w-4 h-4 animate-spin" /> : <TestTube className="w-4 h-4" />}
                  {loading.stripeTest ? "Testing..." : "Test Stripe Connection"}
                </button>
                <button onClick={handleStripeSave} disabled={loading.stripeSave} className="px-3 sm:px-4 py-2 bg-gradient-to-r from-[#00f0ff] to-[#7000ff] text-black rounded-md font-bold font-mono text-sm hover:opacity-90 flex items-center justify-center gap-2 disabled:opacity-50">
                  {loading.stripeSave ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} {loading.stripeSave ? "Saving..." : "Save Stripe Config"}
                </button>
              </div>
              <ResultBanner keyName="stripeTest" />
            </div>
          </div>

          <div className="glass-panel p-4 border border-[#1e293b]/50 bg-[#0a0d14]/40">
            <h3 className="font-mono text-xs text-slate-500 mb-2 flex items-center gap-2"><AlertCircle className="w-3 h-3" /> Setup Instructions</h3>
            <ol className="text-xs font-mono text-slate-400 space-y-1 list-decimal list-inside">
              <li>Go to Stripe Dashboard - Developers - API keys</li>
              <li>Copy your Secret Key</li>
              <li>Create a webhook endpoint and copy the Signing secret</li>
              <li>Test your connection and save!</li>
            </ol>
          </div>
        </div>
      )}

      {activeTab === "smtp" && (
        <div className="grid gap-6">
          <div className="glass-panel p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="p-2 rounded-md bg-[#0a0d14]/60 border border-[#1e293b] shrink-0">
                <Mail className="w-5 h-5 text-[#00f0ff]" />
              </div>
              <div className="min-w-0">
                <p className="font-mono text-sm text-slate-400">SMTP / Email Service</p>
                <p className="font-mono font-bold text-white">{smtpStatus.configured ? "Configured" : "Not Configured"} {smtpStatus.tested && "(Verified)"}</p>
              </div>
            </div>
            <StatusBadge status={smtpStatus.configured && smtpStatus.tested} />
          </div>

          <div className="glass-panel p-5 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div><label className="block text-xs font-mono text-slate-500 mb-1">SMTP Host</label><input type="text" value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} className="w-full bg-[#0a0d14]/80 border border-[#1e293b] text-slate-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#00f0ff]" placeholder="smtp.mailgun.org" /></div>
              <div><label className="block text-xs font-mono text-slate-500 mb-1">Port</label><input type="number" value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: e.target.value })} className="w-full bg-[#0a0d14]/80 border border-[#1e293b] text-slate-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#00f0ff]" placeholder="587" /></div>
              <div><label className="block text-xs font-mono text-slate-500 mb-1">Username</label><input type="text" value={smtp.user} onChange={(e) => setSmtp({ ...smtp, user: e.target.value })} className="w-full bg-[#0a0d14]/80 border border-[#1e293b] text-slate-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#00f0ff]" placeholder="postmaster@smtp.example.com" /></div>
              <div><label className="block text-xs font-mono text-slate-500 mb-1">Password</label><input type="password" value={smtp.pass} onChange={(e) => setSmtp({ ...smtp, pass: e.target.value })} className="w-full bg-[#0a0d14]/80 border border-[#1e293b] text-slate-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#00f0ff]" placeholder="password" /></div>
              <div><label className="block text-xs font-mono text-slate-500 mb-1">From Address</label><input type="email" value={smtp.from} onChange={(e) => setSmtp({ ...smtp, from: e.target.value })} className="w-full bg-[#0a0d14]/80 border border-[#1e293b] text-slate-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#00f0ff]" placeholder="licensing@yourdomain.com" /></div>
              <div>
                <label className="block text-xs font-mono text-slate-500 mb-1">Encryption</label>
                <select value={smtp.encryption} onChange={(e) => setSmtp({ ...smtp, encryption: e.target.value })} className="w-full bg-[#0a0d14]/80 border border-[#1e293b] text-slate-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#00f0ff]">
                  <option value="tls">TLS (Port 587)</option>
                  <option value="ssl">SSL (Port 465)</option>
                  <option value="">None (Port 25)</option>
                </select>
              </div>
            </div>

            <div className="border-t border-[#1e293b] pt-4">
              <div className="flex flex-col gap-2 mb-2">
                <input type="email" value={smtp.test_email_to} onChange={(e) => setSmtp({ ...smtp, test_email_to: e.target.value })} className="w-full sm:flex-1 bg-[#0a0d14]/80 border border-[#1e293b] text-slate-200 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#00f0ff]" placeholder="you@example.com (for test email)" />
                <button onClick={handleSmtpSendTest} disabled={loading.smtpSend || !smtp.test_email_to} className="px-3 py-2 bg-[#0a0d14]/60 border border-[#1e293b] text-slate-300 rounded-md hover:border-[#00f0ff] hover:text-[#00f0ff] font-mono text-sm flex items-center justify-center gap-2 disabled:opacity-50 shrink-0">
                  {loading.smtpSend ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                  {loading.smtpSend ? "Sending..." : "Send Test"}
                </button>
              </div>
              <ResultBanner keyName="smtpSend" />
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 pt-3 border-t border-[#1e293b]">
                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={handleSmtpTest} disabled={loading.smtpTest} className="px-3 sm:px-4 py-2 bg-[#0a0d14]/60 border border-[#1e293b] text-slate-300 rounded-md hover:border-[#00f0ff] hover:text-[#00f0ff] font-mono text-sm flex items-center justify-center gap-2">
                    {loading.smtpTest ? <RefreshCw className="w-4 h-4 animate-spin" /> : <TestTube className="w-4 h-4" />}
                    {loading.smtpTest ? "Testing..." : "Test SMTP Connection"}
                  </button>
                  {results.smtpSave && <span className={`font-mono text-xs ${results.smtpSave.success ? "text-emerald-400" : "text-rose-400"}`}>{results.smtpSave.success ? "Saved" : results.smtpSave.error}</span>}
                </div>
                <button onClick={handleSmtpSave} disabled={loading.smtpSave} className="px-3 sm:px-4 py-2 bg-gradient-to-r from-[#00f0ff] to-[#7000ff] text-black rounded-md font-bold font-mono text-sm hover:opacity-90 flex items-center justify-center gap-2 disabled:opacity-50">
                  {loading.smtpSave ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} {loading.smtpSave ? "Saving..." : "Save SMTP Config"}
                </button>
              </div>
              <ResultBanner keyName="smtpTest" />
            </div>
          </div>

          <div className="glass-panel p-4 border border-[#1e293b]/50 bg-[#0a0d14]/40">
            <h3 className="font-mono text-xs text-slate-500 mb-2 flex items-center gap-2"><AlertCircle className="w-3 h-3" /> SMTP Providers Guide</h3>
            <ul className="text-xs font-mono text-slate-400 space-y-1 list-disc list-inside">
              <li>Mailgun: smtp.mailgun.org, Port 587, TLS</li>
              <li>SendGrid: smtp.sendgrid.net, Port 587, TLS, User=apikey</li>
              <li>Mailtrap: smtp.mailtrap.io, Port 2525, TLS (dev only)</li>
              <li>Gmail: smtp.gmail.com, Port 465, SSL (App Password required)</li>
            </ul>
          </div>
        </div>
      )}
    </div>
    </FuturisticLayout>
  );
}
