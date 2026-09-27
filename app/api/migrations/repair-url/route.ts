import { NextRequest, NextResponse } from "next/server";
import { normalizePublicSiteUrl } from "@/lib/migrationPaths";
import { targetWriteConfig } from "@/lib/migrationExecutor";
import { getMigration, MigrationJob, ServerEndpoint, updateMigration } from "@/lib/storage";

function getTargets(job: MigrationJob): ServerEndpoint[] {
  const targets = job.targets && job.targets.length > 0 ? job.targets : [job.destination];
  return targets.map((target) => ({
    ...target,
    siteUrl: normalizePublicSiteUrl(target.siteUrl, target.fileManagerPath),
  }));
}

function tokenFor(ep: ServerEndpoint | undefined, fallback: string): string {
  if (!ep) return fallback;
  const any = ep as any;
  return any.handshakeToken || any.token || fallback;
}

export async function POST(req: NextRequest) {
  try {
    const { id } = await req.json();
    const job = await getMigration(id);

    if (!job) {
      return NextResponse.json({ success: false, message: "Migration job not found" }, { status: 404 });
    }

    const logs = [...job.logs];
    const push = (message: string, type: MigrationJob["logs"][number]["type"] = "info") => {
      logs.push({ timestamp: new Date().toLocaleTimeString(), message, type });
    };

    const targets = getTargets(job);
    let failed = false;

    push(`=== URL CONFIG REPAIR STARTED for ${targets.length} target(s) ===`);

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const token = tokenFor(target, `slate_auto_tgt_${i}_${id}`);
      const credentials = {
        db_name: target.dbName || "",
        db_user: target.dbUser || "",
        db_password: target.dbPass || "",
        db_host: target.dbHost || "localhost",
      };

      push(`TG[${i + 1}] Repairing base URL config to ${target.siteUrl}...`);
      const result = await targetWriteConfig({
        target,
        credentials,
        newSiteUrl: target.siteUrl,
        handshakeToken: token,
        fixPermissions: false,
      });

      if (result.ok) {
        push(`TG[${i + 1}] URL repair OK: ${result.message}`, "success");
      } else {
        failed = true;
        push(`TG[${i + 1}] URL repair FAIL: ${result.message}`, "error");
      }
    }

    push(
      failed
        ? "=== URL CONFIG REPAIR FINISHED with errors. Review target logs. ==="
        : "=== URL CONFIG REPAIR COMPLETED successfully. ===",
      failed ? "error" : "success"
    );

    const updatedJob = await updateMigration(id, {
      destination: targets[0],
      targets,
      logs,
      currentStep: failed
        ? "URL config repair finished with errors. Review logs."
        : "URL config repaired. Target app base path now matches deployment folder.",
      error: failed ? "One or more target URL config repairs failed." : undefined,
    });

    return NextResponse.json({ success: !failed, job: updatedJob });
  } catch (err: any) {
    return NextResponse.json({ success: false, message: err?.message || "URL config repair failed" }, { status: 500 });
  }
}
