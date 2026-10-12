"use client";
import React, { useEffect, useMemo, useState } from "react";
import FuturisticLayout from "@/components/FuturisticLayout";
import {
  Tag,
  Save,
  Power,
  Check,
  Info,
  Lock,
  Sparkles,
  UploadCloud,
  FileArchive,
  CheckCircle2,
  PackageCheck,
  Layers,
  Globe,
  ShieldCheck,
} from "lucide-react";

interface CatalogPlugin {
  slug: string;
  name: string;
  version: string;
  description: string;
  licensable: boolean;
  system: boolean;
  price: { monthly_cents: number; yearly_cents: number; lifetime_cents: number; currency: string };
  shop: { tagline: string; category: string; order: number; features: string[] };
  inPackages: string[];
}

interface Pkg {
  id: string;
  slug: string;
  name: string;
  description: string;
  productType?: "custom_php" | "wordpress_plugin" | "digital_product";
  assetPath?: string;
  version?: string;
  vaultSha256?: string;
  is_active: boolean;
  sort_order: number;
  pluginSet: string[];
  restrictions: Array<{ match: string; mode: string }>;
  pricing: { monthly_cents: number; yearly_cents: number; lifetime_cents: number; currency: string };
  githubRef: string;
}

const DEFAULT_RESTRICTIONS = [
  { match: "admin/settings.php", mode: "block" },
  { match: "admin/plugins.php", mode: "block" },
  { match: "admin/users.php", mode: "block" },
  { match: "admin/roles.php", mode: "block" },
  { match: "admin/booking/admin/new.php", mode: "block" },
  { match: "admin/booking/admin/settings.php", mode: "block" },
  { match: "plugins/stripe-payment/admin/*", mode: "block" },
  { match: "plugins/booking/admin/appointments.php", mode: "readonly" },
  { match: "plugins/booking/admin/customers.php", mode: "readonly" },
  { match: "plugins/membership/admin/members.php", mode: "readonly" },
  { match: "admin/contact_forms.php", mode: "readonly" },
];

const money = (cents: number, cur = "USD") =>
  `${cur === "USD" ? "$" : ""}${(cents / 100).toFixed(2)}`;

export default function PackagesPage() {
  const [pkgs, setPkgs] = useState<Pkg[]>([]);
  const [catalog, setCatalog] = useState<CatalogPlugin[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [uploadNotice, setUploadNotice] = useState<{
    kind: "ok" | "err";
    text: string;
    details?: { slug: string; assetPath: string; vaultSha256: string; version?: string };
  } | null>(null);

  const [form, setForm] = useState({
    productType: "custom_php" as "custom_php" | "wordpress_plugin" | "digital_product",
    slug: "business-ops",
    name: "Business Ops",
    description: "Slate core + booking + membership + stripe-payment",
    version: "1.0.0",
    assetPath: "",
    vaultSha256: "",
    monthly: "2900",
    yearly: "29000",
    lifetime: "49000",
    githubRef: "v1.4.0",
  });

  // checkbox state: slug -> selected
  const [selected, setSelected] = useState<Record<string, boolean>>({
    booking: true,
    membership: true,
    "stripe-payment": true,
  });

  const load = async () => {
    try {
      const [pkgRes, catRes] = await Promise.all([
        fetch("/api/admin/packages").then((r) => r.json()),
        fetch("/api/plugins/catalog").then((r) => r.json()),
      ]);
      if (pkgRes.success) setPkgs(pkgRes.packages);
      if (catRes.success) {
        setCatalog(catRes.plugins);
        setCatalogError("");
      } else {
        setCatalogError(catRes.error || "Could not read the plugin catalog.");
      }
    } catch (e: any) {
      setCatalogError(e?.message || "Could not reach the server.");
    }
  };

  useEffect(() => {
    load();
  }, []);

  // Only licensable, non-system plugins are sellable inside a package.
  const sellable = useMemo(() => catalog.filter((p) => p.licensable && !p.system), [catalog]);
  const chosen = useMemo(() => sellable.filter((p) => selected[p.slug]).map((p) => p.slug), [sellable, selected]);

  // Live bundle maths
  const totals = useMemo(() => {
    const sum = { monthly: 0, yearly: 0, lifetime: 0 };
    for (const p of sellable) {
      if (!selected[p.slug]) continue;
      sum.monthly += p.price.monthly_cents;
      sum.yearly += p.price.yearly_cents;
      sum.lifetime += p.price.lifetime_cents;
    }
    const price = {
      monthly: Number(form.monthly || 0),
      yearly: Number(form.yearly || 0),
      lifetime: Number(form.lifetime || 0),
    };
    const pct = (p: number, l: number) => (l > 0 && p > 0 && p < l ? Math.round(((l - p) / l) * 100) : 0);
    return {
      sum,
      price,
      pct: {
        monthly: pct(price.monthly, sum.monthly),
        yearly: pct(price.yearly, sum.yearly),
        lifetime: pct(price.lifetime, sum.lifetime),
      },
    };
  }, [sellable, selected, form.monthly, form.yearly, form.lifetime]);

  const toggle = (slug: string) => setSelected((s) => ({ ...s, [slug]: !s[slug] }));
  const selectAll = () => setSelected(Object.fromEntries(sellable.map((p) => [p.slug, true])));
  const clearAll = () => setSelected({});

  const handleZipUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setUploadNotice(null);
    try {
      const fd = new FormData();
      fd.append("file", file);

      const res = await fetch("/api/packages/upload", {
        method: "POST",
        body: fd,
      });
      const data = await res.json();

      if (!data.success) {
        setUploadNotice({ kind: "err", text: data.error || "Upload pipeline failed." });
        return;
      }

      setForm((prev) => ({
        ...prev,
        name: data.name || prev.name,
        slug: data.slug || prev.slug,
        description: data.description || prev.description,
        version: data.version || prev.version,
        assetPath: data.assetPath,
        vaultSha256: data.vaultSha256,
      }));

      setUploadNotice({
        kind: "ok",
        text: `Automated Pipeline Complete: "${data.name}" v${data.version} processed and saved to Vault!`,
        details: {
          slug: data.slug,
          assetPath: data.assetPath,
          vaultSha256: data.vaultSha256,
          version: data.version,
        },
      });
    } catch (err: any) {
      setUploadNotice({ kind: "err", text: err?.message || "Upload failed." });
    } finally {
      setUploading(false);
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.productType === "custom_php" && chosen.length === 0) {
      setNotice({ kind: "err", text: "Select at least one client plugin for this custom PHP package." });
      return;
    }
    if (form.productType === "wordpress_plugin" && !form.assetPath) {
      setNotice({ kind: "err", text: "Please upload your WordPress plugin ZIP to the vault before saving." });
      return;
    }

    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/packages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: form.slug,
          name: form.name,
          description: form.description,
          productType: form.productType,
          assetPath: form.assetPath || undefined,
          version: form.version || undefined,
          vaultSha256: form.vaultSha256 || undefined,
          pluginSet: form.productType === "custom_php" ? chosen : [form.slug],
          restrictions: form.productType === "custom_php" ? DEFAULT_RESTRICTIONS : [],
          pricing: {
            monthly_cents: Number(form.monthly),
            yearly_cents: Number(form.yearly),
            lifetime_cents: Number(form.lifetime),
            currency: "USD",
          },
          githubRef: form.githubRef,
          is_active: true,
        }),
      });
      const d = await res.json();
      if (!d.success) {
        setNotice({ kind: "err", text: d.error || "Save failed" });
        return;
      }
      setPkgs((p) => [d.package, ...p.filter((x) => x.id !== d.package.id)]);
      setNotice({ kind: "ok", text: `Saved "${d.package.name}" (${form.productType.replace("_", " ")}).` });
      load();
    } catch (err: any) {
      setNotice({ kind: "err", text: err?.message || "Save failed" });
    } finally {
      setSaving(false);
    }
  };

  const editPackage = (p: Pkg) => {
    setForm({
      productType: p.productType || "custom_php",
      slug: p.slug,
      name: p.name,
      description: p.description || "",
      version: p.version || "1.0.0",
      assetPath: p.assetPath || "",
      vaultSha256: p.vaultSha256 || "",
      monthly: String(p.pricing?.monthly_cents ?? "2900"),
      yearly: String(p.pricing?.yearly_cents ?? "29000"),
      lifetime: String(p.pricing?.lifetime_cents ?? "49000"),
      githubRef: p.githubRef || "main",
    });
    if (p.productType === "custom_php" && Array.isArray(p.pluginSet)) {
      const newSel: Record<string, boolean> = {};
      for (const s of p.pluginSet) newSel[s] = true;
      setSelected(newSel);
    }
    setNotice({ kind: "ok", text: `Loaded package "${p.name}". Edit details and click Save.` });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const byCategory = useMemo(() => {
    const groups: Record<string, CatalogPlugin[]> = {};
    for (const p of sellable) {
      const c = p.shop.category || "Other";
      (groups[c] = groups[c] || []).push(p);
    }
    return groups;
  }, [sellable]);

  return (
    <FuturisticLayout activeTab="packages">
      <div className="space-y-6 font-mono text-xs">
        <h2 className="text-xl font-extrabold text-white tracking-wider flex items-center gap-2">
          <Tag className="w-6 h-6 text-[#00f0ff]" /> PRODUCT &amp; SUBSCRIPTION PACKAGE BUILDER
        </h2>

        {catalogError && (
          <div className="rounded-xl border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-amber-300">
            Plugin catalog unavailable: {catalogError}. Plugin list below may be incomplete.
          </div>
        )}

        <form onSubmit={save} className="glass-panel rounded-xl p-5 border border-[#1e293b] space-y-6">
          {/* ── Product Type Selector ────────────────────────────── */}
          <div>
            <label className="block text-slate-300 font-bold mb-2 uppercase tracking-wide">
              Product Category
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                {
                  id: "custom_php",
                  title: "Custom PHP Application",
                  desc: "Slate client platform plugins suite with multi-tenant licensing",
                  icon: Layers,
                },
                {
                  id: "wordpress_plugin",
                  title: "WordPress Plugin",
                  desc: "Automated ZIP extraction, Slate Licensing SDK injection & distribution vault",
                  icon: Globe,
                },
                {
                  id: "digital_product",
                  title: "Digital Product",
                  desc: "Downloadable software assets, standalone packages or scripts",
                  icon: PackageCheck,
                },
              ].map((item) => {
                const isSelected = form.productType === item.id;
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setForm((prev) => ({
                        ...prev,
                        productType: item.id as any,
                        slug:
                          item.id === "wordpress_plugin"
                            ? prev.slug === "business-ops"
                              ? "wp-sample-plugin"
                              : prev.slug
                            : prev.slug,
                      }));
                      setUploadNotice(null);
                    }}
                    className={`flex flex-col text-left p-4 rounded-xl border transition-all ${
                      isSelected
                        ? "border-[#00f0ff] bg-[#00f0ff]/10 text-white shadow-lg shadow-[#00f0ff]/10"
                        : "border-[#1e293b] bg-[#0a0d14]/60 text-slate-400 hover:border-slate-600 hover:text-slate-200"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <Icon className={`w-5 h-5 ${isSelected ? "text-[#00f0ff]" : "text-slate-500"}`} />
                      {isSelected && <Check className="w-4 h-4 text-[#00f0ff]" />}
                    </div>
                    <div className="font-bold text-sm text-white mb-1">{item.title}</div>
                    <div className="text-[11px] text-slate-400 leading-tight">{item.desc}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── WordPress Plugin Automated Upload Pipeline ───────── */}
          {form.productType === "wordpress_plugin" && (
            <div className="rounded-xl border border-[#00f0ff]/40 bg-[#00f0ff]/5 p-5 space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <UploadCloud className="w-5 h-5 text-[#00f0ff]" />
                  <span className="font-bold text-white text-sm">
                    AUTOMATED WORDPRESS PLUGIN INGESTION &amp; VAULT
                  </span>
                </div>
                <span className="text-[11px] text-[#00f0ff] uppercase tracking-wider font-semibold">
                  Zero Manual Config Required
                </span>
              </div>
              <p className="text-slate-300 text-xs leading-relaxed">
                Upload your WordPress plugin <code>.zip</code> file. The pipeline automatically extracts the plugin
                headers (Name, Slug, Version, Description), injects the Slate WP Licensing SDK into{" "}
                <code>includes/</code>, wires the bootstrap require, and packages a ready-to-install distribution ZIP
                into the Vault.
              </p>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                <label className="flex-1 cursor-pointer flex items-center justify-center gap-2 px-4 py-3 border border-dashed border-[#00f0ff]/60 rounded-lg bg-[#0a0d14] hover:bg-[#00f0ff]/10 transition text-slate-200">
                  <FileArchive className="w-5 h-5 text-[#00f0ff]" />
                  <span>{uploading ? "Extracting & Ingesting SDK..." : "Choose Plugin ZIP File to Ingest"}</span>
                  <input
                    type="file"
                    accept=".zip"
                    disabled={uploading}
                    onChange={handleZipUpload}
                    className="hidden"
                  />
                </label>
              </div>

              {uploadNotice && (
                <div
                  className={`rounded-lg p-4 border text-xs space-y-2 ${
                    uploadNotice.kind === "ok"
                      ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-200"
                      : "border-rose-500/50 bg-rose-500/10 text-rose-300"
                  }`}
                >
                  <div className="font-bold flex items-center gap-2">
                    {uploadNotice.kind === "ok" ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    ) : (
                      <Info className="w-4 h-4 text-rose-400 shrink-0" />
                    )}
                    {uploadNotice.text}
                  </div>
                  {uploadNotice.details && (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2 border-t border-emerald-500/20 text-[11px] font-mono">
                      <div>
                        <span className="text-slate-400">Slug:</span> {uploadNotice.details.slug}
                      </div>
                      <div>
                        <span className="text-slate-400">Vault Path:</span> {uploadNotice.details.assetPath}
                      </div>
                      <div className="truncate">
                        <span className="text-slate-400">SHA-256:</span> {uploadNotice.details.vaultSha256.slice(0, 16)}...
                      </div>
                    </div>
                  )}
                </div>
              )}

              {form.assetPath && (
                <div className="rounded-lg border border-[#1e293b] bg-[#0a0d14] p-3 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 text-slate-300">
                    <ShieldCheck className="w-4 h-4 text-[#00f0ff]" />
                    <span>
                      Vault Asset Ready: <strong className="text-white">{form.assetPath}</strong>
                    </span>
                  </div>
                  <span className="text-emerald-400 font-bold">READY TO SELL</span>
                </div>
              )}
            </div>
          )}

          {/* ── Identity ─────────────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div>
              <label className="block text-slate-400 mb-1 uppercase">Slug</label>
              <input
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
                className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1 uppercase">Name</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1 uppercase">Version</label>
              <input
                value={form.version}
                onChange={(e) => setForm({ ...form, version: e.target.value })}
                placeholder="1.0.0"
                className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1 uppercase">GitHub Ref / Branch</label>
              <input
                value={form.githubRef}
                onChange={(e) => setForm({ ...form, githubRef: e.target.value })}
                className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white"
              />
            </div>
            <div className="md:col-span-4">
              <label className="block text-slate-400 mb-1 uppercase">Description</label>
              <input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white"
              />
            </div>
          </div>

          {/* ── Plugin selection for custom PHP application ──────── */}
          {form.productType === "custom_php" && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-white font-bold uppercase tracking-wide">
                  Included Slate plugins{" "}
                  <span className="text-[#00f0ff]">({chosen.length} selected)</span>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={selectAll}
                    className="px-3 py-1 rounded border border-[#1e293b] text-slate-300 hover:border-[#00f0ff] hover:text-[#00f0ff]"
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    onClick={clearAll}
                    className="px-3 py-1 rounded border border-[#1e293b] text-slate-300 hover:border-rose-500 hover:text-rose-400"
                  >
                    Clear
                  </button>
                </div>
              </div>

              {sellable.length === 0 ? (
                <div className="text-slate-500 border border-dashed border-[#1e293b] rounded p-4">
                  No licensable plugins found on disk. Add {`"licensable": true`} to a plugin.json to sell it here.
                </div>
              ) : (
                Object.entries(byCategory).map(([cat, items]) => (
                  <div key={cat} className="mb-4">
                    <div className="text-slate-500 uppercase tracking-widest mb-2">{cat}</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                      {items.map((p) => {
                        const on = !!selected[p.slug];
                        return (
                          <label
                            key={p.slug}
                            className={`flex gap-3 items-start rounded-lg border p-3 cursor-pointer transition ${
                              on ? "border-[#00f0ff] bg-[#00f0ff]/5" : "border-[#1e293b] hover:border-slate-600"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => toggle(p.slug)}
                              className="mt-1 accent-[#00f0ff]"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-white font-bold truncate">{p.name}</span>
                                <span className="text-slate-500">v{p.version}</span>
                                {on && <Check className="w-3.5 h-3.5 text-[#00f0ff] shrink-0" />}
                              </div>
                              <div className="text-slate-400 truncate">{p.shop.tagline}</div>
                              <div className="text-slate-500 mt-1">
                                {money(p.price.yearly_cents, p.price.currency)}/yr &middot;{" "}
                                {money(p.price.lifetime_cents, p.price.currency)} lifetime
                              </div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}

              {catalog.some((p) => p.system || !p.licensable) && (
                <div className="mt-2 flex items-start gap-2 text-slate-500">
                  <Lock className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>
                    Always included, never gated:{" "}
                    {catalog
                      .filter((p) => p.system || !p.licensable)
                      .map((p) => p.name)
                      .join(", ")}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* ── Pricing ──────────────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {[
              ["monthly", "Monthly"],
              ["yearly", "Yearly"],
              ["lifetime", "Lifetime"],
            ].map(([k, label]) => {
              const list = totals.sum[k as "monthly" | "yearly" | "lifetime"];
              const price = totals.price[k as "monthly" | "yearly" | "lifetime"];
              const pct = totals.pct[k as "monthly" | "yearly" | "lifetime"];
              return (
                <div key={k} className="rounded-lg border border-[#1e293b] p-3">
                  <label className="block text-slate-400 mb-1 uppercase">{label} (cents)</label>
                  <input
                    value={form[k as "monthly" | "yearly" | "lifetime"]}
                    onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                    className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white"
                  />
                  {form.productType === "custom_php" && (
                    <>
                      <div className="mt-2 text-slate-500">
                        Plugins bought separately: <span className="text-slate-300">{money(list)}</span>
                      </div>
                      {pct > 0 ? (
                        <div className="mt-1 flex items-center gap-1 text-emerald-400">
                          <Sparkles className="w-3 h-3" /> Bundle saves {pct}%
                        </div>
                      ) : price > 0 && list > 0 ? (
                        <div className="mt-1 flex items-center gap-1 text-amber-400">
                          <Info className="w-3 h-3" /> No discount vs separate purchase
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {notice && (
            <div
              className={`rounded-lg px-4 py-3 border ${
                notice.kind === "ok"
                  ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                  : "border-rose-500/50 bg-rose-500/10 text-rose-300"
              }`}
            >
              {notice.text}
            </div>
          )}

          <div className="flex justify-end">
            <button
              disabled={saving}
              className="px-5 py-2 rounded bg-[#00f0ff]/20 border border-[#00f0ff] text-[#00f0ff] font-bold hover:bg-[#00f0ff] hover:text-black disabled:opacity-50 flex items-center gap-2"
            >
              <Save className="w-4 h-4" /> {saving ? "Saving..." : "Save Product Package"}
            </button>
          </div>
        </form>

        {/* ── Existing packages ─────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {pkgs.map((p) => {
            const isWp = p.productType === "wordpress_plugin";
            const isDigital = p.productType === "digital_product";
            const names = (p.pluginSet || []).map((s) => catalog.find((c) => c.slug === s)?.name || s);

            return (
              <div key={p.id} className="glass-panel rounded-xl p-4 border border-[#1e293b]">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-white font-bold">
                      {p.name} <span className="text-slate-500">({p.slug})</span>
                    </span>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded border uppercase font-bold ${
                        isWp
                          ? "border-[#00f0ff]/50 bg-[#00f0ff]/10 text-[#00f0ff]"
                          : isDigital
                          ? "border-purple-500/50 bg-purple-500/10 text-purple-300"
                          : "border-slate-600 bg-slate-800 text-slate-300"
                      }`}
                    >
                      {isWp ? "WP Plugin" : isDigital ? "Digital Asset" : "Custom PHP"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => editPackage(p)}
                      className="px-2 py-0.5 rounded border border-[#1e293b] hover:border-[#00f0ff] hover:text-[#00f0ff] text-slate-400 text-[10px] font-bold transition"
                    >
                      Edit
                    </button>
                    <span className={p.is_active ? "text-emerald-400 font-bold text-[11px]" : "text-slate-500 text-[11px]"}>
                      {p.is_active ? "ACTIVE" : "OFF"}
                    </span>
                  </div>
                </div>

                <div className="text-slate-400 mt-1">{p.description}</div>

                {isWp ? (
                  <div className="text-[#00f0ff] mt-2 flex items-center gap-2">
                    <Globe className="w-3.5 h-3.5" />
                    <span>Version: v{p.version || "1.0.0"}</span>
                    {p.assetPath && (
                      <span className="text-slate-400 text-[11px] truncate">({p.assetPath})</span>
                    )}
                  </div>
                ) : (
                  <div className="text-[#00f0ff] mt-2">
                    Plugins ({names.length}): {names.join(", ")}
                  </div>
                )}

                <div className="text-slate-300 mt-1">
                  {money(p.pricing.monthly_cents)} / {money(p.pricing.yearly_cents)} /{" "}
                  {money(p.pricing.lifetime_cents)} {p.pricing.currency}
                </div>

                <div className="text-slate-500 mt-2">
                  Restrictions: {p.restrictions?.length || 0} rules &middot; ref {p.githubRef}
                </div>
              </div>
            );
          })}
          {pkgs.length === 0 && (
            <div className="text-slate-500">No packages yet. Create Business Ops or upload a WordPress plugin.</div>
          )}
        </div>

        <div className="flex justify-end">
          <a
            href="/pricing"
            className="px-5 py-2 rounded bg-[#00f0ff]/20 border border-[#00f0ff] text-[#00f0ff] font-bold hover:bg-[#00f0ff] hover:text-black"
          >
            Preview Pricing Page
          </a>
        </div>
        <div className="text-slate-500 flex items-center gap-2">
          <Power className="w-3 h-3" /> Automatic Vault pipeline protects WordPress distribution files with fail-closed
          license control.
        </div>
      </div>
    </FuturisticLayout>
  );
}