"use client";
import React, { useEffect, useMemo, useState } from "react";
import FuturisticLayout from "@/components/FuturisticLayout";
import { Tag, Save, Power, Check, Info, Lock, Sparkles } from "lucide-react";

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
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [form, setForm] = useState({
    slug: "business-ops",
    name: "Business Ops",
    description: "Slate core + booking + membership + stripe-payment",
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

  // Live bundle maths - recomputed as boxes are ticked so the operator sees the
  // real discount before saving, rather than discovering it after the fact.
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

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (chosen.length === 0) {
      setNotice({ kind: "err", text: "Select at least one plugin for this package." });
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
          pluginSet: chosen,
          restrictions: DEFAULT_RESTRICTIONS,
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
      setNotice({ kind: "ok", text: `Saved "${d.package.name}" with ${chosen.length} plugin(s).` });
      load();
    } catch (err: any) {
      setNotice({ kind: "err", text: err?.message || "Save failed" });
    } finally {
      setSaving(false);
    }
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
          <Tag className="w-6 h-6 text-[#00f0ff]" /> SUBSCRIPTION PACKAGE BUILDER
        </h2>

        {catalogError && (
          <div className="rounded-xl border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-amber-300">
            Plugin catalog unavailable: {catalogError}. Plugin list below may be incomplete.
          </div>
        )}

        <form onSubmit={save} className="glass-panel rounded-xl p-5 border border-[#1e293b] space-y-6">
          {/* ── Identity ─────────────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {([["slug", "Slug"], ["name", "Name"], ["githubRef", "GitHub ref"]] as Array<[keyof typeof form, string]>).map(
              ([k, label]) => (
                <div key={k}>
                  <label className="block text-slate-400 mb-1 uppercase">{label}</label>
                  <input
                    value={form[k]}
                    onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                    className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white"
                  />
                </div>
              )
            )}
            <div className="md:col-span-3">
              <label className="block text-slate-400 mb-1 uppercase">Description</label>
              <input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white"
              />
            </div>
          </div>

          {/* ── Plugin selection (was a comma-separated text field) ── */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-white font-bold uppercase tracking-wide">
                Included plugins{" "}
                <span className="text-[#00f0ff]">({chosen.length} selected)</span>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={selectAll} className="px-3 py-1 rounded border border-[#1e293b] text-slate-300 hover:border-[#00f0ff] hover:text-[#00f0ff]">
                  Select all
                </button>
                <button type="button" onClick={clearAll} className="px-3 py-1 rounded border border-[#1e293b] text-slate-300 hover:border-rose-500 hover:text-rose-400">
                  Clear
                </button>
              </div>
            </div>

            {sellable.length === 0 ? (
              <div className="text-slate-500 border border-dashed border-[#1e293b] rounded p-4">
                No licensable plugins found on disk. Add {"\"licensable\": true"} to a plugin.json to sell it here.
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
                          <input type="checkbox" checked={on} onChange={() => toggle(p.slug)} className="mt-1 accent-[#00f0ff]" />
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
                  {catalog.filter((p) => p.system || !p.licensable).map((p) => p.name).join(", ")}
                </span>
              </div>
            )}
          </div>

          {/* ── Pricing + live bundle discount ───────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {([["monthly", "Monthly"], ["yearly", "Yearly"], ["lifetime", "Lifetime"]] as Array<[keyof typeof totals.price, string]>).map(
              ([k, label]) => {
                const list = totals.sum[k];
                const price = totals.price[k];
                const pct = totals.pct[k];
                return (
                  <div key={k} className="rounded-lg border border-[#1e293b] p-3">
                    <label className="block text-slate-400 mb-1 uppercase">{label} (cents)</label>
                    <input
                      value={form[k as "monthly" | "yearly" | "lifetime"]}
                      onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                      className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white"
                    />
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
                  </div>
                );
              }
            )}
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
              <Save className="w-4 h-4" /> {saving ? "Saving..." : "Save package (restrictions auto-seeded)"}
            </button>
          </div>
        </form>

        {/* ── Existing packages ─────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {pkgs.map((p) => {
            const names = (p.pluginSet || []).map(
              (s) => catalog.find((c) => c.slug === s)?.name || s
            );
            return (
              <div key={p.id} className="glass-panel rounded-xl p-4 border border-[#1e293b]">
                <div className="flex items-center justify-between">
                  <span className="text-white font-bold">
                    {p.name} <span className="text-slate-500">({p.slug})</span>
                  </span>
                  <span className={p.is_active ? "text-emerald-400" : "text-slate-500"}>
                    {p.is_active ? "ACTIVE" : "OFF"}
                  </span>
                </div>
                <div className="text-slate-400 mt-1">{p.description}</div>
                <div className="text-[#00f0ff] mt-2">Plugins ({names.length}): {names.join(", ")}</div>
                <div className="text-slate-300 mt-1">
                  {money(p.pricing.monthly_cents)} / {money(p.pricing.yearly_cents)} / {money(p.pricing.lifetime_cents)}{" "}
                  {p.pricing.currency}
                </div>
                <div className="text-slate-500 mt-2">
                  Restrictions: {p.restrictions.length} rules &middot; ref {p.githubRef}
                </div>
              </div>
            );
          })}
          {pkgs.length === 0 && <div className="text-slate-500">No packages yet. Create Business Ops + Coaching Suite.</div>}
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
          <Power className="w-3 h-3" /> Plugins are read from slate/plugins/*/plugin.json - only real plugins can be selected.
          Expiry rules block settings/plugins/users/roles and make lists read-only.
        </div>
      </div>
    </FuturisticLayout>
  );
}