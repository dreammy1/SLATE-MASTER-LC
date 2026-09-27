import { NextRequest, NextResponse } from "next/server";
import { getSite, updateSite, getDatabases, addDatabase, updateDatabase } from "@/lib/storage";
import { getAuthPhpUrl } from "@/lib/githubWorkflow";

// ── Helper: call auth.php on the remote server ────────────────────────────────
async function callAgent(
  agentUrl: string,
  action: string,
  body: Record<string, unknown>,
  token: string
) {
  const url = `${agentUrl}?action=${action}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Slate-Token": token,
    },
    body: JSON.stringify({ ...body, token }),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  return { httpCode: res.status, data };
}

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/sites/[id]/database
// → Calls auth.php?action=database_scan, returns list of all databases/users
// ══════════════════════════════════════════════════════════════════════════════
export async function GET(
  req: NextRequest,
  { params: p }: { params: Promise<{ id: string }> }
) {
const params = await p;

  try {
    const site = await getSite(params.id);
    if (!site) {
      return NextResponse.json({ success: false, error: "Site not found" }, { status: 404 });
    }

    const agentUrl = getAuthPhpUrl(site.domain, site.path);
    if (!agentUrl) {
      return NextResponse.json(
        { success: false, error: "No auth.php agent URL configured for this site." },
        { status: 400 }
      );
    }

    const { httpCode, data } = await callAgent(agentUrl, "database_scan", {}, site.handshakeToken);

    if (httpCode >= 400 || data.error) {
      return NextResponse.json(
        { success: false, error: data.error || `Agent returned HTTP ${httpCode}`, agentResponse: data },
        { status: 502 }
      );
    }

    // Also return any databases already linked to this site in local storage
    const allDbs = await getDatabases();
    const linkedDb = allDbs.find((d) => d.linkedSiteId === params.id) || null;

    return NextResponse.json({
      success: true,
      agentVersion: data.version,
      scan: {
        databases: data.databases || [],
        users: data.users || [],
        counts: data.counts || {},
      },
      linkedDb,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/sites/[id]/database
// body: { action: "setup_cpanel" | "create" | "link", ...fields }
// ══════════════════════════════════════════════════════════════════════════════
export async function POST(
  req: NextRequest,
  { params: p }: { params: Promise<{ id: string }> }
) {
const params = await p;

  try {
    const site = await getSite(params.id);
    if (!site) {
      return NextResponse.json({ success: false, error: "Site not found" }, { status: 404 });
    }

    const agentUrl = getAuthPhpUrl(site.domain, site.path);
    if (!agentUrl) {
      return NextResponse.json(
        { success: false, error: "No auth.php agent URL for this site." },
        { status: 400 }
      );
    }

    const body = await req.json();
    const { action } = body;

    // ── A) Link cPanel credentials (one-time setup) ────────────────────────
    if (action === "setup_cpanel") {
      const { cpanel_user, cpanel_api_token } = body;
      if (!cpanel_user || !cpanel_api_token) {
        return NextResponse.json(
          { success: false, error: "cpanel_user and cpanel_api_token are required." },
          { status: 400 }
        );
      }

      const { httpCode, data } = await callAgent(
        agentUrl,
        "cpanel_setup",
        { cpanel_user, cpanel_api_token },
        site.handshakeToken
      );

      if (httpCode >= 400 || data.error) {
        return NextResponse.json(
          { success: false, error: data.error || `Agent HTTP ${httpCode}`, agentResponse: data },
          { status: 502 }
        );
      }

      await updateSite(params.id, { cpanelLinked: true });

      return NextResponse.json({ success: true, cpanel_user, agentResponse: data });
    }

    // ── B) Auto-provision a new database ──────────────────────────────────
    if (action === "create") {
      const appName = (body.app_name || site.domain.replace(/https?:\/\//, "").split(".")[0]).slice(0, 8);

      const { httpCode, data } = await callAgent(
        agentUrl,
        "database_create",
        { app_name: appName },
        site.handshakeToken
      );

      if (httpCode >= 400 || data.error) {
        return NextResponse.json(
          { success: false, error: data.error || `Agent HTTP ${httpCode}`, agentResponse: data },
          { status: 502 }
        );
      }

      const creds = data.credentials || {};

      // Persist to local database store
      const allDbs = await getDatabases();
      const existingLinked = allDbs.find((d) => d.linkedSiteId === params.id);

      let savedDb;
      const dbPayload = {
        name: creds.db_name || "",
        user: creds.db_user || "",
        host: creds.db_host || "localhost",
        port: creds.db_port || 3306,
        password: creds.db_password || "",
        mode: "cpanel" as const,
        size: "0 MB",
        tablesCount: 0,
        status: "ACTIVE" as const,
        linkedSiteId: params.id,
        provisionedAt: new Date().toISOString(),
        lastTested: null,
      };

      if (existingLinked) {
        savedDb = await updateDatabase(existingLinked.id, dbPayload);
      } else {
        savedDb = await addDatabase(dbPayload);
      }

      // Update site's dbStatus
      await updateSite(params.id, { dbStatus: "CONNECTED", dbSize: "0 MB" });

      return NextResponse.json({
        success: true,
        status: "PROVISIONED",
        credentials: creds,
        savedDb,
        steps: data.steps || [],
        message: data.message,
      });
    }

    // ── C) Link an existing database (manual entry) ────────────────────────
    if (action === "link") {
      const { db_name, db_user, db_password, db_host = "localhost", db_port = 3306 } = body;
      if (!db_name || !db_user) {
        return NextResponse.json(
          { success: false, error: "db_name and db_user are required." },
          { status: 400 }
        );
      }

      const allDbs = await getDatabases();
      const existing = allDbs.find((d) => d.linkedSiteId === params.id);

      const dbPayload = {
        name: db_name,
        user: db_user,
        host: db_host,
        port: db_port,
        password: db_password || "",
        mode: "cpanel" as const,
        size: "—",
        tablesCount: 0,
        status: "ACTIVE" as const,
        linkedSiteId: params.id,
        provisionedAt: new Date().toISOString(),
        lastTested: null,
      };

      let savedDb;
      if (existing) {
        savedDb = await updateDatabase(existing.id, dbPayload);
      } else {
        savedDb = await addDatabase(dbPayload);
      }

      await updateSite(params.id, { dbStatus: "CONNECTED" });

      return NextResponse.json({ success: true, status: "LINKED", savedDb });
    }

    return NextResponse.json({ success: false, error: "Unknown action. Use: setup_cpanel | create | link" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
