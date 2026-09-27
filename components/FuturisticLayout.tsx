"use client";

import React, { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { 
  Server,
  ArrowRightLeft, 
  GitBranch, 
  Database, 
  Activity, 
  Bell, 
  Terminal,
  Search,
  Zap,
  Radio,
  CreditCard,
  Shield,
  Package,
  Eye,
  LogOut,
} from "lucide-react";

interface FuturisticLayoutProps {
  children: React.ReactNode;
  searchQuery?: string;
  onSearchChange?: (val: string) => void;
  activeTab?: string;
}

function SidebarNav({ activeTab }: { activeTab?: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentTab = activeTab || searchParams.get("tab") || "targets";

  type SidebarLink = {
    label: string;
    href: string;
    icon: any;
    tab?: string;
    nested?: boolean;
    parent?: string;
  };

  const isLinkActive = (link: SidebarLink) => {
    const [path, query] = link.href.split("?");
    if (query) {
      const expectedTab = new URLSearchParams(query).get("tab");
      return pathname === path && searchParams.get("tab") === expectedTab;
    }
    if (link.tab) {
      if (path === "/sites") {
        // Keep Sites highlighted for its parent-section tabs; Terminal / Logs
        // has its own entry and owns ?tab=logs.
        return pathname === path && currentTab === link.tab && searchParams.get("tab") !== "logs";
      }
      return pathname === path && currentTab === link.tab;
    }
    return pathname === path || pathname.startsWith(`${path}/`);
  };

  const licensingParentActive =
    pathname === "/licenses" ||
    pathname === "/packages" ||
    pathname === "/pricing" ||
    (pathname === "/sites" && searchParams.get("tab") !== "logs");

  const licensingLinks: SidebarLink[] = [
    { label: "Packages", href: "/packages", icon: Package, tab: "packages", parent: "licenses" },
    { label: "Preview Pricing Page", href: "/pricing", icon: Eye, nested: true, parent: "licenses" },
    { label: "Licenses", href: "/licenses", icon: Shield, tab: "licenses", parent: "licenses" },
    { label: "Sites", href: "/sites", icon: Server, tab: "targets", parent: "licenses" },
  ];

  const operationsLinks: SidebarLink[] = [
    { label: "Migrations", href: "/migrations", icon: ArrowRightLeft },
    { label: "GitHub Repos", href: "/settings/github", icon: GitBranch },
    { label: "Terminal / Logs", href: "/sites?tab=logs", icon: Terminal },
    { label: "Integrations", href: "/integrations", icon: CreditCard },
  ];

  const renderLinks = (links: SidebarLink[]) => (
    <div className="mt-1 space-y-1">
      {links.map((item) => {
        const Icon = item.icon;
        const isActive = isLinkActive(item);
        return (
          <Link
            key={item.label}
            href={item.href}
            className={`flex items-center gap-3 rounded-md text-xs font-mono transition-all duration-200 ${
              item.nested ? "ml-5 border-l border-[#1e293b] py-2 pl-3 pr-3" : "px-3 py-2.5"
            } ${
              isActive
                ? "bg-[#00f0ff]/10 text-[#00f0ff] border border-[#00f0ff]/40 shadow-[0_0_15px_rgba(0,240,255,0.25)] font-bold"
                : "text-slate-400 hover:text-white hover:bg-[#171f33] hover:border-slate-700 border border-transparent"
            }`}
          >
            <Icon className={`w-4 h-4 ${isActive ? "text-[#00f0ff]" : "text-slate-400"}`} />
            {item.label}
          </Link>
        );
      })}
    </div>
  );

  return (
    <div className="space-y-5">
      <section>
        <Link
          href="/licenses"
          className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-xs font-mono uppercase tracking-wider transition-all duration-200 ${
            licensingParentActive
              ? "text-[#00f0ff] font-bold"
              : "text-slate-500 hover:text-slate-300"
          }`}
        >
          Licenses Management
        </Link>
        {renderLinks(licensingLinks)}
      </section>

      <section>
        <div className="text-[10px] uppercase font-mono tracking-wider text-slate-500 px-3">
          Command Modules
        </div>
        {renderLinks(operationsLinks)}
      </section>
    </div>
  );
}

export default function FuturisticLayout({ children, searchQuery, onSearchChange, activeTab }: FuturisticLayoutProps) {
  const [activeTargets, setActiveTargets] = useState(3);
  const [localSearch, setLocalSearch] = useState(searchQuery || "");

  useEffect(() => {
    fetch("/api/sites")
      .then((r) => r.json())
      .then((data) => {
        if (data.success && Array.isArray(data.sites)) {
          const online = data.sites.filter((s: any) => s.status === "ONLINE").length;
          setActiveTargets(online);
        }
      })
      .catch(() => {});
  }, []);

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    setLocalSearch(e.target.value);
    if (onSearchChange) {
      onSearchChange(e.target.value);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0d14] text-slate-100 flex flex-col scanline-bg selection:bg-[#00f0ff] selection:text-black">
      {/* Top Futuristic Operations Header */}
      <header className="h-16 border-b border-[#1e293b] bg-[#111625]/90 backdrop-blur-md px-6 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-4">
          <Link href="/sites" className="relative flex items-center justify-center">
            <div className="w-10 h-10 rounded-lg bg-[#00f0ff]/10 border border-[#00f0ff] flex items-center justify-center shadow-[0_0_15px_rgba(0,240,255,0.35)]">
              <Zap className="w-5 h-5 text-[#00f0ff] animate-pulse" />
            </div>
            <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-emerald-500 rounded-full animate-ping" />
            <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-emerald-500 rounded-full" />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <Link href="/sites" className="font-extrabold tracking-widest text-lg bg-gradient-to-r from-[#00f0ff] via-white to-[#7000ff] bg-clip-text text-transparent hover:opacity-90">
                SLATE DEVOPS OS
              </Link>
              <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-[#00f0ff]/20 text-[#00f0ff] border border-[#00f0ff]/30">
                v2.4-PROD
              </span>
            </div>
            <p className="text-[11px] text-slate-400 font-mono flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> LIVE TELEMETRY ENGINE
            </p>
          </div>
        </div>

        {/* Global Live Diagnostics Bar */}
        <div className="hidden lg:flex items-center gap-6 font-mono text-xs text-slate-300">
          <div className="flex items-center gap-2 bg-[#0a0d14]/60 border border-[#1e293b] px-3 py-1.5 rounded-md">
            <Radio className="w-3.5 h-3.5 text-[#00f0ff] animate-pulse" />
            <span>NODE CPU:</span>
            <span className="text-[#00f0ff] font-bold">14.2%</span>
          </div>
          <div className="flex items-center gap-2 bg-[#0a0d14]/60 border border-[#1e293b] px-3 py-1.5 rounded-md">
            <Activity className="w-3.5 h-3.5 text-[#7000ff]" />
            <span>MEM:</span>
            <span className="text-[#7000ff] font-bold">1.8 / 16 GB</span>
          </div>
          <div className="flex items-center gap-2 bg-[#0a0d14]/60 border border-[#1e293b] px-3 py-1.5 rounded-md">
            <Server className="w-3.5 h-3.5 text-emerald-400" />
            <span>TARGETS:</span>
            <span className="text-emerald-400 font-bold">{activeTargets} ONLINE</span>
          </div>
        </div>

        {/* Right Action Icons */}
        <div className="flex items-center gap-4">
          <div className="relative hidden md:block">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input 
              type="text" 
              placeholder="Query domains, repos, SHAs..." 
              value={localSearch}
              onChange={handleSearch}
              className="bg-[#0a0d14]/80 border border-[#1e293b] text-xs rounded-md pl-9 pr-4 py-2 w-64 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-[#00f0ff]"
            />
          </div>
          <button 
            onClick={() => alert("All cluster nodes and CI/CD triggers are healthy.")} 
            className="p-2 rounded-md bg-[#111625] border border-[#1e293b] hover:border-[#00f0ff] transition-colors relative"
            title="Cluster Alerts"
          >
            <Bell className="w-4 h-4 text-slate-300" />
            <span className="absolute top-1 right-1 w-2 h-2 bg-emerald-500 rounded-full" />
          </button>
          <button
            onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST" });
              window.location.href = "/admin/login";
            }}
            className="p-2 rounded-md bg-[#111625] border border-[#1e293b] hover:border-rose-500 transition-colors relative"
            title="Sign Out"
          >
            <LogOut className="w-4 h-4 text-slate-400 hover:text-rose-400" />
          </button>
        </div>
      </header>

      {/* Main Container */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <aside className="w-64 border-r border-[#1e293b] bg-[#111625]/50 flex flex-col justify-between p-4 hidden md:flex">
          <Suspense fallback={<div className="text-slate-600 text-xs p-3">Loading menu...</div>}>
            <SidebarNav activeTab={activeTab} />
          </Suspense>

          {/* System Agent Status Card */}
          <div className="p-3 rounded-lg bg-[#0a0d14]/80 border border-[#1e293b] space-y-2">
            <div className="flex items-center justify-between text-[11px] font-mono">
              <span className="text-slate-400">AGENT HEALTH</span>
              <span className="text-emerald-400 flex items-center gap-1 font-bold">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> 100% OK
              </span>
            </div>
            <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
              <div className="bg-gradient-to-r from-[#00f0ff] to-[#7000ff] h-full w-[94%]" />
            </div>
            <p className="text-[10px] text-slate-500 font-mono truncate">SSL & Token Handshakes Valid</p>
          </div>
        </aside>

        {/* Content Body */}
        <main className="flex-1 overflow-y-auto p-6 space-y-6">
          {children}
        </main>
      </div>
    </div>
  );
}
