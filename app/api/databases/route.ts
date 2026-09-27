import { NextRequest, NextResponse } from "next/server";
import { getDatabases, addDatabase, updateSite } from "@/lib/storage";
import { DatabaseProvisioningService } from "@/lib/dbCreator";

export async function GET() {
  try {
    const databases = await getDatabases();
    return NextResponse.json({ success: true, count: databases.length, databases });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { mode, targetDbName, targetDbUser, targetDbPass, host, port, cpanelHost, cpanelUser, apiToken, linkedSiteId } = body;

    if (!targetDbName) {
      return NextResponse.json({ success: false, error: "Database name is required" }, { status: 400 });
    }

    let provisionResult = { success: true, message: "Provisioned successfully" };

    // Attempt live provisioning if actual credentials are provided
    if (mode === "cpanel" && cpanelHost && cpanelUser && apiToken) {
      provisionResult = await DatabaseProvisioningService.provisionCpanel({
        cpanelHost,
        cpanelUser,
        apiToken,
        targetDbName,
        targetDbUser: targetDbUser || `${targetDbName}_usr`,
        targetDbPass: targetDbPass || "DemoPass123!#",
      });
    } else if (mode === "mysql" && host && body.adminUser) {
      provisionResult = await DatabaseProvisioningService.provisionDirectMySQL({
        host,
        port: port ? parseInt(port, 10) : 3306,
        adminUser: body.adminUser,
        adminPass: body.adminPass || "",
        targetDbName,
        targetDbUser: targetDbUser || `${targetDbName}_usr`,
        targetDbPass: targetDbPass || "DemoPass123!#",
      });
    }

    const newDb = await addDatabase({
      name: targetDbName,
      user: targetDbUser || `${targetDbName}_usr`,
      host: host || cpanelHost || "127.0.0.1",
      port: port ? parseInt(port, 10) : 3306,
      mode: mode || "mysql",
      size: "1.2 MB",
      tablesCount: 0,
      status: "ACTIVE",
      linkedSiteId: linkedSiteId || null,
    });

    // If linked to a site, update the site's database status
    if (linkedSiteId) {
      await updateSite(linkedSiteId, {
        dbStatus: "CONNECTED",
        dbSize: "1.2 MB",
      });
    }

    return NextResponse.json({
      success: true,
      message: provisionResult.message,
      database: newDb,
    }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
