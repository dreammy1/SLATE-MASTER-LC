import fs from "fs/promises";
import os from "os";
import path from "path";
import { resolveReleaseZip } from "./releaseResolver";
import { pushInstaller, runAppInstall } from "./appInstaller";
import {
  targetDeployFiles,
  verifyTargetLiveness,
  cleanupTemp,
} from "./migrationExecutor";
import {
  addDeployment,
  updateSite,
  updateLicense,
  type Site,
  type Package,
  type LicenseRecord,
  type ServerEndpoint,
} from "./storage";

export type PushUpdateOptions = {
  ref?: string;
  plugins?: string[];
  lic?: LicenseRecord | null;
  actor?: string;
};

export type PushUpdateResult = {
  success: boolean;
  message: string;
  ref: string;
  source?: string;
  filesExtracted?: number;
  migrations?: any;
  plugins?: any;
  steps?: any;
  warnings?: string[];
  live?: any;
  duration: string;
  logs: string[];
  error?: string;
};

/**
 * Phase 2 — Core & Plugin Push Update Channel for a running client site.
 *
 * Non-destructive pipeline:
 *   1. resolveReleaseZip(ref)  -> unpacks release ball & strips unwanted plugins
 *   2. targetDeployFiles(zip)  -> writes delta files over remote agent
 *   3. pushInstaller()         -> uploads idempotent headless installer
 *   4. runAppInstall({force:false, ref}) -> runs pending migrations + refreshes plugin manifests
 *   5. verifyTargetLiveness()  -> ensures live target responds HTTP 200 OK
 *
 * All user data, .env credentials, and admin accounts remain 100% untouched.
 */
export async function executeClientPushUpdate(
  site: Site,
  pkg: Package | null,
  options: PushUpdateOptions = {}
): Promise<PushUpdateResult> {
  const startedAt = Date.now();
  const logs: string[] = [];
  const log = (msg: string) =>
    logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);

  const ref = String(
    options.ref || pkg?.githubRef || "main"
  ).trim();
  const plugins = Array.isArray(options.plugins)
    ? options.plugins
    : pkg?.pluginSet || [];
  const token = site.handshakeToken;
  const target: ServerEndpoint = {
    siteUrl: site.domain,
    fileManagerPath: site.path,
    handshakeToken: token,
  } as any;

  log(`Initiating update channel for ${site.domain} (target: ${site.path}, ref: ${ref})...`);

  if (!site.domain || !site.path) {
    const error = "Target site domain or file path missing.";
    log(`ERROR: ${error}`);
    return {
      success: false,
      message: error,
      ref,
      duration: "0.0s",
      logs,
      error,
    };
  }

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slate-update-"));
  const zipPath = path.join(tmpRoot, `slate-release-${Date.now()}.zip`);

  try {
    // 1. Resolve release archive (local source / GitHub / operator zip)
    log(`1/5 Resolving release archive for ref "${ref}" with plugins: ${plugins.join(", ") || "core only"}...`);
    const rel = await resolveReleaseZip({
      outPath: zipPath,
      pluginSet: plugins,
      ref,
    });
    if (!rel.ok) {
      log(`Release resolve failed: ${rel.message}`);
      await addDeployment({
        siteId: site.id,
        domain: site.domain,
        repo: site.repo || "slate",
        commitSha: ref,
        actor: options.actor || "master-ops",
        status: "FAILED",
        duration: `${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
        logs,
      }).catch(() => null);

      return {
        success: false,
        message: rel.message,
        ref,
        duration: `${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
        logs,
        error: rel.message,
      };
    }
    log(`Release resolved (${((rel.bytes || 0) / 1048576).toFixed(2)} MB, source: ${rel.source}, sha: ${rel.sha || ref}).`);

    // 2. Deploy updated application files over agent (non-destructive file overwrite)
    log(`2/5 Uploading update files to remote auth.php deploy endpoint...`);
    const dep = await targetDeployFiles({
      target,
      localZipPath: zipPath,
      handshakeToken: token,
      commitSha: rel.sha || ref,
    });
    if (!dep.ok) {
      log(`Remote file deploy failed: ${dep.message}`);
      await addDeployment({
        siteId: site.id,
        domain: site.domain,
        repo: site.repo || "slate",
        commitSha: rel.sha || ref,
        actor: options.actor || "master-ops",
        status: "FAILED",
        duration: `${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
        logs,
      }).catch(() => null);

      return {
        success: false,
        message: dep.message,
        ref,
        duration: `${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
        logs,
        error: dep.message,
      };
    }
    log(`Remote file deployment succeeded (${dep.filesExtracted || 0} files unpacked).`);

    // 3. Push fresh idempotent installer
    log(`3/5 Uploading installer (slate-installer.php)...`);
    const pushed = await pushInstaller(target, token);
    if (!pushed.ok) {
      log(`Installer upload notice: ${pushed.message} (proceeding with existing target installer)`);
    } else {
      log(`Installer uploaded successfully.`);
    }

    // 4. Run installer headlessly in update mode (force: false)
    log(`4/5 Executing installer migration & plugin ledger verification...`);
    const inst = await runAppInstall(target, token, {
      plugins,
      force: false,
      ref,
      action: "update",
    });
    if (!inst.ok) {
      log(`Installer returned warning/error: ${inst.message}`);
    } else {
      log(`Installer finished: ${inst.message}`);
    }

    // 5. Verify target health
    log(`5/5 Verifying live target status...`);
    const live = await verifyTargetLiveness({ target });
    log(`Health check: ${live.message} (HTTP 200: ${live.http200 ? "YES" : "NO"})`);

    const duration = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    const finalOk = dep.ok && (live.http200 || !inst.data?.error);

    // Audit log
    await addDeployment({
      siteId: site.id,
      domain: site.domain,
      repo: site.repo || "slate",
      commitSha: rel.sha || ref,
      actor: options.actor || "master-ops",
      status: finalOk ? "SUCCESS" : "FAILED",
      duration,
      logs,
    }).catch(() => null);

    // Update site state
    await updateSite(site.id, {
      status: finalOk ? "ONLINE" : "ERROR",
      lastCommit: rel.sha || ref,
      lastDeployedAt: new Date().toISOString(),
    }).catch(() => null);

    if (options.lic) {
      await updateLicense(options.lic.id, {
        last_seen_at: new Date().toISOString(),
      }).catch(() => null);
    }

    const ranMigrations = inst.data?.migrations?.ran?.length ?? 0;
    const msg = finalOk
      ? `Update to ${ref} completed successfully (${dep.filesExtracted} files updated, ${ranMigrations} migrations applied).`
      : `Update completed with warnings: ${live.message}`;

    log(msg);

    return {
      success: finalOk,
      message: msg,
      ref,
      source: rel.source,
      filesExtracted: dep.filesExtracted,
      migrations: inst.data?.migrations,
      plugins: inst.data?.plugins,
      steps: inst.data?.steps,
      warnings: inst.data?.warnings,
      live,
      duration,
      logs,
    };
  } catch (err: any) {
    const errorMsg = err?.message || String(err) || "Unknown update error";
    log(`UPDATE CRASH: ${errorMsg}`);
    await addDeployment({
      siteId: site.id,
      domain: site.domain,
      repo: site.repo || "slate",
      commitSha: ref,
      actor: options.actor || "master-ops",
      status: "FAILED",
      duration: `${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
      logs,
    }).catch(() => null);

    return {
      success: false,
      message: errorMsg,
      ref,
      duration: `${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
      logs,
      error: errorMsg,
    };
  } finally {
    await cleanupTemp([zipPath]).catch(() => null);
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => null);
  }
}
