"use client";

import React, { useEffect, useState } from "react";
import FuturisticLayout from "@/components/FuturisticLayout";
import { Tag, Plus, Save, Power } from "lucide-react";

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
  { match: "plugins/booking/admin/new.php", mode: "block" },
  { match: "plugins/booking/admin/settings.php", mode: "block" },
  { match: "plugins/stripe-payment/admin/*", mode: "block" },
  { match: "plugins/booking/admin/appointments.php", mode: "readonly" },
  { match: "plugins/booking/admin/customers.php", mode: "readonly" },
  { match: "plugins/membership/admin/members.php", mode: "readonly" },
  { match: "admin/contact_forms.php", mode: "readonly" },
];

export default function PackagesPage() {
  const [pkgs, setPkgs] = useState<Pkg[]>([]);
  const [form, setForm] = useState({ slug: "business-ops", name: "Business Ops", description: "Slate core + booking + membership + stripe-payment", pluginSet: "booking,membership,stripe-payment", monthly: "2900", yearly: "29000", lifetime: "99000", githubRef: "v1.4.0" });

  const load = async () => {
    const r = await fetch("/api/admin/packages");
    const d = await r.json();
    if (d.success) setPkgs(d.packages);
  };
  useEffect(() => { load(); }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch("/api/admin/packages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: form.slug,
        name: form.name,
        description: form.description,
        pluginSet: form.pluginSet.split(",").map((s) => s.trim()).filter(Boolean),
        restrictions: DEFAULT_RESTRICTIONS,
        pricing: { monthly_cents: Number(form.monthly), yearly_cents: Number(form.yearly), lifetime_cents: Number(form.lifetime), currency: "USD" },
        githubRef: form.githubRef,
        is_active: true,
      }),
    });
    const d = await res.json();
    if (!d.success) { alert(d.error || "Save failed"); return; }
    setPkgs((p) => [d.package, ...p.filter((x) => x.id !== d.package.id)]);
  };

  return (
    <FuturisticLayout activeTab="packages">
      <div className="space-y-6 font-mono text-xs">
        <h2 className="text-xl font-extrabold text-white tracking-wider flex items-center gap-2">
          <Tag className="w-6 h-6 text-[#00f0ff]" /> SUBSCRIPTION PACKAGE BUILDER
        </h2>
        <form onSubmit={save} className="glass-panel rounded-xl p-5 border border-[#1e293b] grid grid-cols-1 md:grid-cols-2 gap-3">
          {(Object.keys(form) as Array<keyof typeof form>).map((k) => (
            <div key={k}>
              <label className="block text-slate-400 mb-1 uppercase">{k}</label>
              <input value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                className="w-full bg-[#0a0d14] border border-[#1e293b] rounded px-3 py-2 text-white" />
            </div>
          ))}
          <div className="md:col-span-2 flex justify-end">
            <button className="px-5 py-2 rounded bg-[#00f0ff]/20 border border-[#00f0ff] text-[#00f0ff] font-bold hover:bg-[#00f0ff] hover:text-black flex items-center gap-2">
              <Save className="w-4 h-4" /> Save package (restrictions auto-seeded)
            </button>
          </div>
        </form>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {pkgs.map((p) => (
            <div key={p.id} className="glass-panel rounded-xl p-4 border border-[#1e293b]">
              <div className="flex items-center justify-between">
                <span className="text-white font-bold">{p.name} <span className="text-slate-500">({p.slug})</span></span>
                <span className={p.is_active ? "text-emerald-400" : "text-slate-500"}>{p.is_active ? "ACTIVE" : "OFF"}</span>
              </div>
              <div className="text-slate-400 mt-1">{p.description}</div>
              <div className="text-[#00f0ff] mt-2">Plugins: {p.pluginSet.join(", ")}</div>
              <div className="text-slate-300 mt-1">${(p.pricing.monthly_cents / 100).toFixed(2)} / ${(p.pricing.yearly_cents / 100).toFixed(2)} / {(p.pricing.lifetime_cents / 100).toFixed(2)} {p.pricing.currency}</div>
              <div className="text-slate-500 mt-2">Restrictions: {p.restrictions.length} rules · ref {p.githubRef}</div>
            </div>
          ))}
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
        <div className="text-slate-500 flex items-center gap-2"><Power className="w-3 h-3" /> Seed defaults: settings/plugins/users/roles blocked on expiry; lists readonly. Edit JSON via API for custom rules.</div>
      </div>
    </FuturisticLayout>
  );
}
