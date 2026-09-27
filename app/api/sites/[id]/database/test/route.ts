import { NextRequest, NextResponse } from "next/server";
import { getSite, getDatabases, updateDatabase } from "@/lib/storage";
import { getAuthPhpUrl } from "@/lib/githubWorkflow";

// POST /api/sites/[id]/database/test
// Tests a MySQL connection via auth.php?action=database_probe
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

    // Get linked database credentials
    const allDbs = await getDatabases();
    const linkedDb = allDbs.find((d) => d.linkedSiteId === params.id);

    if (!linkedDb) {
      return NextResponse.json(
        { success: false, error: "No database linked to this site. Provision one first." },
        { status: 404 }
      );
    }

    const probePayload = {
      db_name:     linkedDb.name,
      db_user:     linkedDb.user,
      db_password: (linkedDb as any).password || "",
      db_host:     linkedDb.host,
      db_port:     linkedDb.port,
      token:       site.handshakeToken,
    };

    const res = await fetch(`${agentUrl}?action=database_probe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Slate-Token": site.handshakeToken,
      },
      body: JSON.stringify(probePayload),
      signal: AbortSignal.timeout(20_000),
    });

    const text = await res.text();
    let data: any = {};
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    const connected = data.status === "CONNECTED";

    // Update database record with latest test results
    if (connected) {
      await updateDatabase(linkedDb.id, {
        status: "ACTIVE",
        tablesCount: data.table_count ?? linkedDb.tablesCount,
        size: data.size_mb ? `${data.size_mb} MB` : linkedDb.size,
        lastTested: new Date().toISOString(),
      } as any);
    } else {
      await updateDatabase(linkedDb.id, {
        status: "ERROR",
        lastTested: new Date().toISOString(),
      } as any);
    }

    return NextResponse.json({
      success: true,
      connected,
      status: data.status,
      details: {
        db_name:      data.db_name,
        db_host:      data.db_host,
        table_count:  data.table_count,
        size_mb:      data.size_mb,
        mysql_version: data.mysql_version,
      },
      error: data.error || null,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
