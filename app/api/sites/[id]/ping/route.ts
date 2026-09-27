import { NextRequest, NextResponse } from "next/server";
import { getSite, updateSite, Site } from "@/lib/storage";
import { verifyEndpoint, getAgentUrl } from "@/lib/migrationExecutor";

export async function POST(_req: NextRequest, { params: p }: { params: Promise<{ id: string }> }) {
const params = await p;

  try {
    const site = await getSite(params.id);
    if (!site) {
      return NextResponse.json({ success: false, error: "Site not found" }, { status: 404 });
    }

    const startTime = Date.now();
    let status: "ONLINE" | "OFFLINE" = "OFFLINE";
    let latencyMs: number | null = null;
    const notes: string[] = [];
    const siteUrl = site.domain.startsWith("http") ? site.domain : `https://${site.domain}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);

      const res = await fetch(siteUrl, {
        method: "HEAD",
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timeoutId);

      latencyMs = Date.now() - startTime;
      if (res.status >= 200 && res.status < 500) {
        status = "ONLINE";
      } else {
        notes.push(`HTTP ${res.status}`);
      }
    } catch (err: any) {
      notes.push(`HEAD ${site.domain} failed: ${err?.message || String(err)}`);
    }

    if (status !== "ONLINE" && site.path) {
      try {
        const t0 = Date.now();
        const pseudo = {
          cpanelHost: "",
          cpanelUser: "",
          cpanelApiToken: "",
          fileManagerPath: site.path,
          siteUrl,
          dbHost: "",
          dbName: "",
          dbUser: "",
          dbPass: "",
        } as any;
        (pseudo as any).serverName = site.domain;
        const agentUrl = getAgentUrl(pseudo.siteUrl, pseudo.fileManagerPath);
        if (agentUrl) {
          const diag = await verifyEndpoint(pseudo);
          if (diag.ok) {
            latencyMs = Math.max(1, Date.now() - t0);
            status = "ONLINE";
            notes.push(`Agent reachable at ${agentUrl}`);
          } else {
            notes.push(`Agent unreachable at ${agentUrl}: ${diag.message}`);
          }
        }
      } catch (e2: any) {
        notes.push(`Agent probe error: ${e2?.message || String(e2)}`);
      }
    }

    if (latencyMs == null) {
      latencyMs = Date.now() - startTime;
    }

    const latency = `${latencyMs}ms`;
    const updated = await updateSite(site.id, { latency, status });

    return NextResponse.json({
      success: true,
      latency,
      status,
      notes: notes.length ? notes : undefined,
      site: updated,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
