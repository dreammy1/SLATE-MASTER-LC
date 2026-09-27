import { NextRequest, NextResponse } from "next/server";
import { getSite, updateSite, getDatabases, Site } from "@/lib/storage";
import { verifyEndpoint, handshakeEndpoint, getAgentUrl } from "@/lib/migrationExecutor";

async function jsonPost<T = any>(url: string, body: any, headers: Record<string, string> = {}, timeoutMs = 10000): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(t);
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = { _raw: text }; }
    return { ok: res.ok, status: res.status, data, error: res.ok ? undefined : (data?.error || `HTTP ${res.status}`) };
  } catch (err: any) {
    clearTimeout(t);
    return {
      ok: false,
      status: 0,
      error: err?.name === "AbortError" ? `Request timed out after ${timeoutMs}ms` : (err?.message || String(err)),
    };
  }
}

export async function POST(req: NextRequest, { params: p }: { params: Promise<{ id: string }> }) {
const params = await p;

  try {
    const site = await getSite(params.id);
    if (!site) {
      return NextResponse.json({ success: false, error: "Site not found" }, { status: 404 });
    }

    const allDbs = await getDatabases();
    const linked = allDbs.find((d) => d.linkedSiteId === site.id);
    const pseudo = buildEndpointFromSite(site);
    const agentUrl = getAgentUrl(pseudo.siteUrl, pseudo.fileManagerPath);

    let dbStatus: Site["dbStatus"] = site.dbStatus || (linked ? "CONNECTED" : "UNLINKED");
    let dbSize = site.dbSize || (linked ? linked.size || "0 MB" : "0 MB");
    let tablesCount = 0;
    const notes: string[] = [];

    // Step 1 — Agent reachability
    const diag = await verifyEndpoint(pseudo as any);
    if (!diag.ok) {
      notes.push(`Agent unreachable at ${agentUrl || "(unknown)"}: ${diag.message}. Preserving locally stored DB status.`);
    } else if (site.handshakeToken) {
      const hs = await handshakeEndpoint(pseudo as any, site.handshakeToken, req.nextUrl?.origin || "master-os");
      if (!hs.ok) notes.push(`Handshake failed: ${hs.message}`);
    }

    // Step 2 — If a DB is linked AND agent is reachable, PROBE it for real
    if (linked && diag.ok) {
      try {
        const extraHeaders: Record<string, string> = {};
        if (site.handshakeToken) extraHeaders["X-Slate-Token"] = site.handshakeToken;
        const probe = await jsonPost(
          `${agentUrl}?action=database_probe`,
          {
            db_name: linked.name,
            db_user: linked.user,
            db_password: linked.password || "",
            db_host: linked.host || "localhost",
            db_port: linked.port || 3306,
          },
          extraHeaders,
          10000
        );
        if (probe.ok && probe.data?.connected === true) {
          dbStatus = "CONNECTED";
          const mb = probe.data.size_mb ?? probe.data.sizeMB ?? null;
          tablesCount = probe.data.tables ?? probe.data.table_count ?? 0;
          if (mb != null) {
            dbSize = `${Number(mb).toFixed(1)} MB`;
          } else if (linked.size) {
            dbSize = linked.size;
          }
          if (tablesCount) notes.push(`Probed ${tablesCount} tables in ${linked.name}`);
        } else {
          notes.push(
            `database_probe failed for ${linked.name}: ${probe.data?.error || probe.error || "unknown"}. Keeping last known status.`
          );
        }
      } catch (err: any) {
        notes.push(`database_probe exception: ${err.message}. Keeping last known status.`);
      }
    } else if (!linked) {
      notes.push(`No linked database for site ${site.domain}. Link a DB from the Databases page to probe it.`);
      dbStatus = "UNLINKED";
      dbSize = "0 MB";
    }

    const updated = await updateSite(site.id, { dbStatus, dbSize });

    return NextResponse.json({
      success: dbStatus === "CONNECTED" || dbStatus === "UNLINKED",
      message:
        dbStatus === "CONNECTED"
          ? `Database schema and privileges synchronized successfully for ${site.domain}.`
          : dbStatus === "UNLINKED"
          ? `No DB linked for ${site.domain}. Nothing to synchronize.`
          : `DB sync did not fully succeed for ${site.domain}.`,
      dbStatus,
      dbSize,
      tablesCount,
      notes,
      linkedDatabase: linked ? { id: linked.id, name: linked.name } : null,
      site: updated,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

function buildEndpointFromSite(site: Site) {
  return {
    serverName: site.domain,
    cpanelHost: "",
    cpanelUser: "",
    cpanelApiToken: "",
    fileManagerPath: site.path,
    siteUrl: site.domain.startsWith("http") ? site.domain : `https://${site.domain}`,
    dbHost: "localhost",
    dbName: "",
    dbUser: "",
    dbPass: "",
  };
}
