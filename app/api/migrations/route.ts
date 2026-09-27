import { NextRequest, NextResponse } from "next/server";
import { addMigration, deleteMigration, getMigrations, MigrationJob, ServerEndpoint, updateMigration } from "@/lib/storage";
import { normalizePublicSiteUrl } from "@/lib/migrationPaths";

export async function GET() {
  try {
    const jobs = (await getMigrations()).map(normalizeJobForResponse);
    return NextResponse.json({ success: true, jobs });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const source = body.source;
    const targets = normalizeTargets(body);
    const destination = targets[0];

    if (!source || targets.length === 0) {
      return NextResponse.json(
        { success: false, error: "Source and at least one destination endpoint are required" },
        { status: 400 }
      );
    }

    const options = {
      syncFiles: body.options?.syncFiles ?? true,
      syncDatabase: body.options?.syncDatabase ?? true,
      replaceDomainUrls: body.options?.replaceDomainUrls ?? true,
      fixFilePermissions: body.options?.fixFilePermissions ?? true,
    };

    const job = await addMigration({
      title: body.title || `${source.serverName || "Source"} -> ${destination.serverName || "Destination"}`,
      source,
      destination,
      targets,
      options,
      status: "READY",
      progress: 0,
      totalFiles: options.syncFiles ? 3840 * targets.length : 0,
      transferredFiles: 0,
      totalDbTables: options.syncDatabase ? 28 * targets.length : 0,
      transferredDbTables: 0,
      currentStep: "Configuration ready. Press 'Start Migration' to initiate.",
      logs: [
        {
          timestamp: new Date().toLocaleTimeString(),
          message: "Migration plan configured and staged.",
          type: "info",
        },
      ],
    } satisfies Omit<MigrationJob, "id" | "createdAt">);

    return NextResponse.json({ success: true, job });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const id = body.id;
    const source = body.source;
    const targets = normalizeTargets(body);
    const destination = targets[0];

    if (!id) {
      return NextResponse.json({ success: false, error: "Migration id is required" }, { status: 400 });
    }

    if (!source || targets.length === 0) {
      return NextResponse.json(
        { success: false, error: "Source and at least one destination endpoint are required" },
        { status: 400 }
      );
    }

    const options = {
      syncFiles: body.options?.syncFiles ?? true,
      syncDatabase: body.options?.syncDatabase ?? true,
      replaceDomainUrls: body.options?.replaceDomainUrls ?? true,
      fixFilePermissions: body.options?.fixFilePermissions ?? true,
    };

    const updatedJob = await updateMigration(id, {
      title: body.title || `${source.serverName || "Source"} -> ${destination.serverName || "Destination"}`,
      source,
      destination,
      targets,
      options,
      status: "READY",
      progress: 0,
      totalFiles: options.syncFiles ? 3840 * targets.length : 0,
      transferredFiles: 0,
      totalDbTables: options.syncDatabase ? 28 * targets.length : 0,
      transferredDbTables: 0,
      currentStep: "Configuration updated. Press 'Start Migration' to initiate.",
      logs: [
        {
          timestamp: new Date().toLocaleTimeString(),
          message: "Migration plan updated and staged.",
          type: "info",
        },
      ],
    });

    if (!updatedJob) {
      return NextResponse.json({ success: false, error: "Migration job not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, job: updatedJob });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ success: false, error: "Migration id is required" }, { status: 400 });
    }

    const deleted = await deleteMigration(id);
    if (!deleted) {
      return NextResponse.json({ success: false, error: "Migration job not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

function normalizeTargets(body: any): ServerEndpoint[] {
  if (Array.isArray(body.targets) && body.targets.length > 0) {
    return body.targets.map(normalizeEndpoint);
  }

  if (body.destination) {
    return [normalizeEndpoint(body.destination)];
  }

  return [];
}

function normalizeEndpoint(endpoint: ServerEndpoint): ServerEndpoint {
  if (!endpoint) return endpoint;
  return {
    ...endpoint,
    siteUrl: normalizePublicSiteUrl(endpoint.siteUrl, endpoint.fileManagerPath),
  };
}

function normalizeJobForResponse(job: MigrationJob): MigrationJob {
  const targets = (job.targets && job.targets.length > 0 ? job.targets : [job.destination]).map(normalizeEndpoint);
  return {
    ...job,
    destination: targets[0],
    targets,
  };
}
