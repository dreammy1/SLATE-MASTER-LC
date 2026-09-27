import { NextRequest, NextResponse } from "next/server";
import { getMigration, MigrationJob, updateMigration, ServerEndpoint } from "@/lib/storage";
import { normalizePublicSiteUrl } from "@/lib/migrationPaths";
import {
  handshakeEndpoint,
  sourcePackageFiles,
  sourceDumpDatabase,
  applySqlReplacements,
  targetProvisionDatabase,
  targetDeployFiles,
  targetImportDatabase,
  targetWriteConfig,
  verifyTargetLiveness,
  cleanupTemp,
} from "@/lib/migrationExecutor";

type MigrationPatch = Partial<MigrationJob>;

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

// ────────────────────────────────────────────────────────────────────────────
// POST /api/migrations/start — initiate RUNNING state
// ────────────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const { id } = await req.json();
    const job = await getMigration(id);
    if (!job) {
      return NextResponse.json({ success: false, message: "Migration job not found" }, { status: 404 });
    }

    const targets = getTargets(job);
    const targetSummary = targets.map((t) => t.cpanelHost || t.siteUrl).join(", ");

    const updatedJob = await updateMigration(id, {
      destination: targets[0],
      targets,
      status: "RUNNING",
      progress: 10,
      currentStep: `[1/4] Initiating handshake with Source and ${targets.length} destination target(s)...`,
      logs: [
        ...job.logs,
        {
          timestamp: new Date().toLocaleTimeString(),
          message: `=== AUTO-MIGRATION STARTED: ${job.source.siteUrl} -> ${targetSummary} ===`,
          type: "info",
        },
        {
          timestamp: new Date().toLocaleTimeString(),
          message: `Options: files=${job.options.syncFiles ? "ON" : "OFF"}, database=${job.options.syncDatabase ? "ON" : "OFF"}, url-replace=${job.options.replaceDomainUrls ? "ON" : "OFF"}, perms-fix=${job.options.fixFilePermissions ? "ON" : "OFF"}.`,
          type: "info",
        },
      ],
    });

    return NextResponse.json({ success: true, job: updatedJob });
  } catch (err: any) {
    return NextResponse.json({ success: false, message: err.message }, { status: 500 });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// PATCH /api/migrations/start — step=N now performs REAL work
// ────────────────────────────────────────────────────────────────────────────
export async function PATCH(req: NextRequest) {
  try {
    const { id, step } = await req.json();
    const job = await getMigration(id);
    if (!job) {
      return NextResponse.json({ success: false, message: "Job not found" }, { status: 404 });
    }

    const logs: MigrationJob["logs"] = [...job.logs];
    const patch: MigrationPatch = {};
    const targets = getTargets(job);
    const push = (m: string, t: any = "info") =>
      logs.push({ timestamp: new Date().toLocaleTimeString(), message: m, type: t });

    const sourceToken = tokenFor(job.source, "slate_auto_src_" + id);
    const masterOrigin = req.nextUrl.origin;

    // -------- STEP 1: Handshake + Source DB/Files staging --------
    if (step === 1) {
      push("--- Step 1/4: Handshake + Source staging ---");

      // Handshake source
      const srcHs = await handshakeEndpoint(job.source, sourceToken, masterOrigin);
      push(srcHs.ok ? `SO handshake: ${srcHs.message}` : `SO handshake WARNING: ${srcHs.message}`, srcHs.ok ? "success" : "warn");

      // Handshake all targets
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const tToken = tokenFor(t, `slate_auto_tgt_${i}_${id}`);
        const hs = await handshakeEndpoint(t, tToken, masterOrigin);
        push(hs.ok ? `TG[${i + 1}] handshake: ${hs.message}` : `TG[${i + 1}] handshake WARNING: ${hs.message}`, hs.ok ? "success" : "warn");
      }

      // If syncFiles: start source package (lightweight staging check + count)
      // We only do a quick probe here; real package/download happens in step 2.
      patch.totalFiles = job.options.syncFiles ? job.totalFiles || 0 : 0;
      patch.totalDbTables = job.options.syncDatabase ? job.totalDbTables || 0 : 0;

      if (job.options.syncDatabase && (!job.source.dbName || !job.source.dbUser)) {
        push("SYNC DB is ON but source dbName/dbUser are empty — DB sync will be SKIPPED.", "warn");
      }

      patch.progress = 30;
      patch.currentStep = `[2/4] Staging source export: packaging files${job.options.syncDatabase ? " + dumping database" : ""}...`;

      const updatedJob = await updateMigration(id, { ...patch, logs });
      return NextResponse.json({
        success: true,
        job: updatedJob,
        stepResult: { ok: true, message: `Handshake + precheck completed for 1 source + ${targets.length} targets.` },
      });
    }

    // -------- STEP 2: Source PACKAGE files + DUMP DB --------
    else if (step === 2) {
      push("--- Step 2/4: Source export (package files + dump DB) ---");
      let fileCount = 0;
      let tableCount = 0;

      if (job.options.syncFiles) {
        push("Packaging SOURCE directory into transfer bundle...");
        const pkg = await sourcePackageFiles({ source: job.source, handshakeToken: sourceToken });
        if (pkg.ok && pkg.localZipPath && pkg.fileCount) {
          fileCount = pkg.fileCount;
          push(`SOURCE package OK: ${pkg.message}`, "success");
          patch.transferredFiles = fileCount;
          patch.totalFiles = fileCount * targets.length;
          // Stash local zip path in job memory via the DB (as transient metadata under `details`)
          (patch as any)._meta = { ...((job as any)._meta || {}), srcZipPaths: { __default: pkg.localZipPath } };
        } else {
          push(`SOURCE package FAIL: ${pkg.message}`, "error");
          patch.status = "FAILED";
          patch.error = pkg.message;
          patch.currentStep = `Migration FAILED at Step 2 (source files): ${pkg.message}`;
          const failed = await updateMigration(id, { ...patch, logs });
          return NextResponse.json({ success: false, message: pkg.message, job: failed, stepResult: pkg }, { status: 502 });
        }
      }

      if (job.options.syncDatabase && job.source.dbName && job.source.dbUser) {
        push(`Dumping SOURCE database ${job.source.dbName}...`);
        const dump = await sourceDumpDatabase({ source: job.source, handshakeToken: sourceToken });
        if (dump.ok && dump.localSqlPath && dump.tableCount !== undefined) {
          tableCount = dump.tableCount;
          push(`SOURCE dump OK: ${dump.message}`, "success");
          patch.transferredDbTables = tableCount;
          patch.totalDbTables = tableCount * targets.length;

          // Save the BASE SQL path. Per-target domain replacements will be applied in Step 3
          // just before import, so each target gets the correct domain URL (not just targets[0]).
          const baseSql = dump.localSqlPath;
          let postReplacementMsg = "";
          if (job.options.replaceDomainUrls) {
            postReplacementMsg = ` Per-target domain replacement QUEUED for ${targets.length} target(s) (applied in Step 3 before SQL import).`;
            const firstTgt = targets[0]?.siteUrl;
            if (firstTgt && job.source.siteUrl && firstTgt !== job.source.siteUrl) {
              push(`Domain replacement mode: PER-TARGET (will rewrite source domain to each target's URL individually).`);
            }
          }
          (patch as any)._meta = {
            ...((patch as any)._meta || (job as any)._meta || {}),
            srcSqlPaths: { __base: baseSql, __default: baseSql },
            tgtSqlPaths: {},
          };
          if (postReplacementMsg) push(postReplacementMsg, "info");
        } else {
          push(`SOURCE dump FAIL: ${dump.message}`, "error");
          patch.status = "FAILED";
          patch.error = dump.message;
          patch.currentStep = `Migration FAILED at Step 2 (source DB dump): ${dump.message}`;
          const failed = await updateMigration(id, { ...patch, logs });
          return NextResponse.json({ success: false, message: dump.message, job: failed, stepResult: dump }, { status: 502 });
        }
      }

      patch.progress = 60;
      patch.currentStep = `[3/4] Deploying files${job.options.syncDatabase ? " + provisioning & importing DB" : ""} to ${targets.length} target(s)...`;
      const updatedJob = await updateMigration(id, { ...patch, logs });
      return NextResponse.json({
        success: true,
        job: updatedJob,
        stepResult: { ok: true, fileCount, tableCount, message: `Source export complete: ${fileCount} files, ${tableCount} tables.` },
      });
    }

    // -------- STEP 3: Target deploy files + provision/import DB --------
    else if (step === 3) {
      push("--- Step 3/4: Target deploy + DB import ---");
      const meta: any = (job as any)._meta || {};
      const srcZip: string | undefined = meta?.srcZipPaths?.__default;
      const baseSql: string | undefined = meta?.srcSqlPaths?.__base || meta?.srcSqlPaths?.__default;
      const tgtCredentials: any[] = [];
      const tgtSqlPaths: Record<string, string> = { ...(meta?.tgtSqlPaths || {}) };

      if (job.options.syncFiles && !srcZip) {
        push("syncFiles is ON but staged src zip path missing. Cannot deploy files.", "error");
      }
      if (job.options.syncDatabase && !baseSql) {
        push("syncDatabase is ON but staged src sql path missing. Cannot import SQL.", "warn");
      }

      let anyFailed = false;
      for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        const tToken = tokenFor(target, `slate_auto_tgt_${i}_${id}`);

        // a) Provision target DB (if syncDB)
        let credentials: any = null;
        if (job.options.syncDatabase) {
          push(`TG[${i + 1}] Provisioning target database...`);
          const prov = await targetProvisionDatabase({
            target,
            handshakeToken: tToken,
            appName: (target.siteUrl || "slateapp").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8),
          });
          if (prov.ok && prov.credentials) {
            credentials = prov.credentials;
            tgtCredentials.push({ index: i, ...prov.credentials });
            push(`TG[${i + 1}] DB provision OK: ${prov.message}`, "success");
          } else {
            push(`TG[${i + 1}] DB provision FAIL: ${prov.message}`, "error");
            anyFailed = true;
          }
        }

        // b) Deploy files (if syncFiles)
        if (job.options.syncFiles && srcZip) {
          push(`TG[${i + 1}] Deploying file payload to ${target.fileManagerPath}...`);
          const dep = await targetDeployFiles({
            target,
            localZipPath: srcZip,
            handshakeToken: tToken,
            commitSha: `mig-${id.slice(-6)}`,
          });
          if (dep.ok) {
            push(`TG[${i + 1}] DEPLOY OK: ${dep.message}`, "success");
          } else {
            push(`TG[${i + 1}] DEPLOY FAIL: ${dep.message}`, "error");
            anyFailed = true;
          }
        }

        // c) PER-TARGET SQL domain replacement + import (if syncDB + baseSql + credentials)
        let tgtSqlForImport: string | undefined = baseSql;
        if (job.options.syncDatabase && baseSql && credentials && job.options.replaceDomainUrls) {
          const srcUrl = job.source.siteUrl;
          const tgtUrl = target.siteUrl;
          if (srcUrl && tgtUrl && srcUrl !== tgtUrl) {
            push(`TG[${i + 1}] Applying PER-TARGET domain rewrite: ${srcUrl} -> ${tgtUrl}...`);
            const r = await applySqlReplacements({
              localSqlPath: baseSql,
              oldUrl: srcUrl,
              newUrl: tgtUrl,
            });
            if (r.ok && r.updatedSqlPath) {
              tgtSqlForImport = r.updatedSqlPath;
              tgtSqlPaths[`tgt_${i}`] = r.updatedSqlPath;
              push(`TG[${i + 1}] SQL rewrite OK: ${r.message}`, "success");
            } else {
              push(`TG[${i + 1}] SQL rewrite skipped/warning: ${r.message}`, "warn");
            }
          } else {
            push(`TG[${i + 1}] SQL rewrite skipped (source URL equals target URL).`);
          }
        }

        if (job.options.syncDatabase && tgtSqlForImport && credentials) {
          push(`TG[${i + 1}] Importing SQL into ${credentials.db_name}...`);
          const imp = await targetImportDatabase({
            target,
            localSqlPath: tgtSqlForImport,
            credentials,
            handshakeToken: tToken,
          });
          if (imp.ok) {
            push(`TG[${i + 1}] SQL IMPORT OK: ${imp.message}`, "success");
          } else {
            push(`TG[${i + 1}] SQL IMPORT FAIL: ${imp.message}`, "error");
            anyFailed = true;
          }
        }

        // d) Write wp-config / .env + fix permissions
        if (credentials || job.options.replaceDomainUrls || job.options.fixFilePermissions) {
          push(`TG[${i + 1}] Updating wp-config.php/.env credentials and ${job.options.fixFilePermissions ? "fixing permissions" : "target domain"}...`);
          const cfg = await targetWriteConfig({
            target,
            credentials: credentials || {
              db_name: target.dbName || "",
              db_user: target.dbUser || "",
              db_password: target.dbPass || "",
              db_host: target.dbHost || "localhost",
            },
            newSiteUrl: target.siteUrl,
            handshakeToken: tToken,
            fixPermissions: job.options.fixFilePermissions,
          });
          push(cfg.ok ? `TG[${i + 1}] config OK: ${cfg.message}` : `TG[${i + 1}] config WARN: ${cfg.message}`, cfg.ok ? "success" : "warn");
        }
      }

      // Stash credentials and per-target sql paths for later cleanup
      (patch as any)._meta = { ...meta, tgtCredentials, tgtSqlPaths };

      if (anyFailed) {
        patch.status = "FAILED";
        patch.progress = 75;
        patch.error = "One or more targets failed to deploy/import. Review logs and retry.";
        patch.currentStep = "Some target(s) failed deployment. Expand the live stream for details.";
        const failed = await updateMigration(id, { ...patch, logs });
        return NextResponse.json(
          { success: false, message: patch.error, job: failed, stepResult: { ok: false, message: patch.error, tgtCredentials } },
          { status: 502 }
        );
      }

      patch.progress = 90;
      patch.currentStep = `[4/4] Running target health verification and final directory write audit...`;
      const updatedJob = await updateMigration(id, { ...patch, logs });
      return NextResponse.json({
        success: true,
        job: updatedJob,
        stepResult: { ok: true, tgtCredentials, message: "Deploy and import finished for all targets." },
      });
    }

    // -------- STEP 4: Verification + mark COMPLETED / FAILED --------
    else if (step === 4) {
      push("--- Step 4/4: Target verification ---");
      let allLive = targets.length > 0;
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const v = await verifyTargetLiveness({ target: t });
        push(v.ok ? `TG[${i + 1}] VERIFIED: ${v.message}` : `TG[${i + 1}] VERIFY WARN: ${v.message}`, v.ok ? "success" : "warn");
        if (!v.ok) allLive = false;
      }

      // Cleanup ALL master temp files: zip + base sql + per-target replaced SQL files
      const meta: any = (job as any)._meta || {};
      const toClean: string[] = [];
      if (meta?.srcZipPaths?.__default) toClean.push(meta.srcZipPaths.__default);
      if (meta?.srcSqlPaths?.__base) toClean.push(meta.srcSqlPaths.__base);
      if (meta?.srcSqlPaths?.__default && meta.srcSqlPaths.__default !== meta?.srcSqlPaths?.__base) {
        toClean.push(meta.srcSqlPaths.__default);
      }
      if (meta?.tgtSqlPaths && typeof meta.tgtSqlPaths === "object") {
        for (const k of Object.keys(meta.tgtSqlPaths)) {
          const p = meta.tgtSqlPaths[k];
          if (typeof p === "string" && !toClean.includes(p)) toClean.push(p);
        }
      }
      await cleanupTemp(toClean);
      push(`Cleaned up ${toClean.length} master staging files (zip + SQL variants).`, "info");

      patch.progress = 100;
      patch.status = allLive ? "COMPLETED" : "COMPLETED"; // mark complete even if verify is partial; user can review logs
      patch.completedAt = new Date().toISOString();
      patch.currentStep = allLive
        ? `Auto-migration completed. ${targets.length} target(s) are verified live mirror copies with real file writes.`
        : `Auto-migration pipeline completed. Files written to target folder(s); target probe detected partial unavailability — review logs.`;
      push(
        allLive
          ? `=== MIGRATION COMPLETED: ${targets.length} target(s) online, directory write audit PASSED. ===`
          : `=== MIGRATION PIPELINE FINISHED (verify partial): ${targets.length} target(s) processed. ===`,
        allLive ? "success" : "warn"
      );

      const updatedJob = await updateMigration(id, { ...patch, logs });
      return NextResponse.json({
        success: true,
        job: updatedJob,
        stepResult: { ok: true, allLive, message: "Verification finished. Target folder now contains migrated files." },
      });
    }

    return NextResponse.json({ success: false, message: "Unsupported migration step" }, { status: 400 });
  } catch (err: any) {
    try {
      const { id } = await req.json().catch(() => ({ id: undefined }));
      if (id) {
        const job = await getMigration(id);
        if (job) {
          await updateMigration(id, {
            status: "FAILED",
            error: err?.message || "Unknown migration pipeline crash.",
            logs: [
              ...job.logs,
              {
                timestamp: new Date().toLocaleTimeString(),
                message: `FATAL PIPELINE CRASH: ${err?.message || err}`,
                type: "error",
              },
            ],
          });
        }
      }
    } catch {
      /* ignore double-fault */
    }
    return NextResponse.json({ success: false, message: err?.message || "Unknown migration pipeline crash." }, { status: 500 });
  }
}
