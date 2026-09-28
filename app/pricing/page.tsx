"use client";
import React, { useEffect, useState } from "react";
import { OrderForm, BootstrapRunner } from "./order-form";
interface PubPkg { id: string; slug: string; name: string; description: string; pluginSet: string[]; pricing: { monthly_cents: number; yearly_cents: number; lifetime_cents: number; currency: string }; }
export default function PricingPage() {
  const [pkgs, setPkgs] = useState<PubPkg[]>([]);
  const [cycle, setCycle] = useState<"monthly"|"yearly"|"lifetime">("monthly");
  const [selected, setSelected] = useState<PubPkg | null>(null);
  const [order, setOrder] = useState<any>(null);
  const [progress, setProgress] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  useEffect(() => { fetch("/api/packages").then((r) => r.json()).then((d) => { if (d.success) setPkgs(d.packages); }).catch(() => {}); }, []);
  const price = (p: PubPkg) => { const c = cycle === "monthly" ? p.pricing.monthly_cents : cycle === "yearly" ? p.pricing.yearly_cents : p.pricing.lifetime_cents; return `${(c/100).toFixed(2)} ${p.pricing.currency}`; };
  return (
    <div className="min-h-screen bg-[#0a0d14] text-slate-100 p-4 sm:p-6 font-mono text-sm w-full overflow-x-hidden">
      <h1 className="text-2xl font-extrabold text-center">Slate Packages</h1>
      <div className="flex justify-center gap-2 my-4">
        {(["monthly","yearly","lifetime"] as const).map((c) => (
          <button key={c} onClick={() => setCycle(c)} className={`px-4 py-1.5 rounded border ${cycle===c?"border-[#00f0ff] text-[#00f0ff]":"border-[#1e293b] text-slate-400"}`}>{c}</button>
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-4xl mx-auto">
        {pkgs.map((p) => (
          <div key={p.id} className={`rounded-xl p-5 border ${selected?.id===p.id?"border-[#00f0ff]":"border-[#1e293b]"} bg-[#111625]`}>
            <div className="text-lg font-bold text-white">{p.name}</div>
            <div className="text-slate-400 text-xs mt-1">{p.description}</div>
            <div className="text-[#00f0ff] text-xs mt-2">Includes: {p.pluginSet.join(" + ")}</div>
            <div className="text-xl font-extrabold mt-2">{price(p)} <span className="text-xs text-slate-500">/{cycle}</span></div>
            <button onClick={() => setSelected(p)} className="mt-3 px-4 py-2 rounded bg-[#00f0ff]/20 border border-[#00f0ff] text-[#00f0ff] font-bold w-full">Choose {p.name}</button>
          </div>
        ))}
        {pkgs.length===0 && <div className="text-slate-500 col-span-2 text-center">No packages yet. Create them in Master Packages page.</div>}
      </div>
      {selected && <OrderForm pkg={selected} cycle={cycle} onOrder={(o)=>{setOrder(o);setProgress(5);setLog([`Order ${o.id} created (${o.status}). Approve then Run bootstrap.`]);}} />}
      {order && <BootstrapRunner order={order} progress={progress} setProgress={setProgress} log={log} setLog={setLog} />}
    </div>
  );
}
