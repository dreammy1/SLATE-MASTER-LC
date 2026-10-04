import { NextRequest, NextResponse } from "next/server";
import { corsPreflight, withCors, CORS_STREAM_HEADERS } from "@/lib/cors";
import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import {
  findLicenseByHash, getPackage, getOrder, updateOrder, updateSite, getSite, updateLicense,
} from "@/lib/storage";
import { hashLicenseKey, isValidKeyFormat } from "@/lib/licensing";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { resolveReleaseZip } from "@/lib/releaseResolver";
import { pushInstaller, runAppInstall, getAppInstallStatus } from "@/lib/appInstaller";
import { guideForStage } from "@/lib/bootstrapGuide";
import { resolveMasterOrigin } from "@/lib/masterOrigin";
import {
  targetDeployFiles, targetWriteConfig, verifyTargetLiveness, cleanupTemp, handshakeEndpoint,
} from "@/lib/migrationExecutor";

/**
 * Phase B — full client install (NDJSON progress stream).
 *
 *   RESOLVE  -> fetch the release, strip the zipball root, keep only the
 *               plugins the client's package includes
 *   DEPLOY   -> push slate-installer.php + the application files via the agent
 *   CONFIG   -> write .env (DB + APP_URL + APP/CRON secrets + LICENSE_KEY),
 *               rebase .htaccess, restore .installed, push restriction rules
 *   INSTALL  -> headless install: migrations, admin user, package plugins, marker
 *   VERIFY   -> agent + installer status + site HTTP
 *
 * Every failure emits { error, failedStage, guide } so the browser can show a
 * clear reason and numbered manual recovery steps. Re-running is safe.
 */
export async function OPTIONS() {
  // The activation page runs on the customer's own domain and calls this endpoint
  // cross-origin, so the browser sends a preflight first. Without this the whole
  // activation reports "Failed to fetch". See lib/cors.ts.
  return corsPreflight();
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any));
  const rawKey = String(body.key || "").trim();
  const domain = String(body.domain || "").trim().replace(/\/+$/, "");
  if (!isValidKeyFormat(rawKey)) return withCors(NextResponse.json({ success: false, error: "Invalid key." }, { status: 400 }));

  const lic = await findLicenseByHash(hashLicenseKey(rawKey));
  if (!lic) return withCors(NextResponse.json({ success: false, error: "Unknown key." }, { status: 404 }));

  const norm = (u: string) => u.toLowerCase().replace(/\/+$/, "");
  if (norm(lic.domain) !== norm(domain)) {
    return withCors(NextResponse.json({ success: false, error: "This key was issued for a different domain." }, { status: 403 }));
  }
  if (lic.status === "revoked" || lic.status === "cancelled") {
    return withCors(NextResponse.json({ success: false, error: `License is ${lic.status}.` }, { status: 403 }));
  }

  const pkg = await getPackage(lic.package_id);
  if (!pkg) return withCors(NextResponse.json({ success: false, error: "Package missing." }, { status: 500 }));
  const site = lic.siteId ? await getSite(lic.siteId) : null;
  if (!site) {
    return withCors(NextResponse.json(
      { success: false, error: "Site not registered. Run the setup step (bootstrap) first." },
      { status: 400 }
    ));
  }
  const order = lic.orderId ? await getOrder(lic.orderId) : undefined;

  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();
  const state = { stage: "VERIFY", percent: 2, warnings: [] as string[] };

  const emit = async (data: any) => {
    try { await writer.write(encoder.encode(JSON.stringify(data) + "\n")); } catch { /* disconnected */ }
  };

  /**
   * Keepalive for the same reason as Phase A: file copying through the agent
   * can run for minutes, and an idle NDJSON stream gets dropped by browsers and
   * proxies — which looked to the customer like a frozen progress bar.
   */
  const heartbeat = setInterval(() => {
    void emit({
      heartbeat: true,
      stage: state.stage,
      percent: state.percent,
      message: `Still working on ${String(state.stage).toLowerCase()}... (large copies take a few minutes)`,
    });
  }, 10_000);


  const ctx = () => ({ host: order?.cpanelHost, dbName: order?.dbName, remoteDir: site.path, siteUrl: site.domain });

  /** Persist failure + emit the reason and the manual recovery steps. */
  const fail = async (err: any, stageName?: string) => {
    const reason = err?.message || String(err) || "Unknown error.";
    const failedStage = stageName || state.stage;
    const guide = guideForStage(failedStage, reason, ctx());
    await emit({ stage: failedStage, percent: state.percent, error: reason, failedStage, guide, warnings: state.warnings });
    if (lic.orderId) {
      await updateOrder(lic.orderId, {
        status: "failed", error: reason, progressStage: failedStage, progressPercent: state.percent,
      }).catch(() => {});
    }
    if (lic.siteId) {
      await updateSite(lic.siteId, { status: "ERROR" }).catch(() => {});
    }
  };


  (async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slate-full-"));
    const cleanups: string[] = [tmpRoot];
    let zipPath = "";
    try {
      const token = site.handshakeToken;
      const target = { siteUrl: site.domain, fileManagerPath: site.path, handshakeToken: token } as any;

      if (lic.orderId) {
        await updateOrder(lic.orderId, { status: "install_running", progressPercent: 2, progressStage: state.stage, error: undefined });
      }

      /* ── 1. RESOLVE: release archive + plugin allow-list ───────────── */
      state.stage = "RESOLVE";
      await emit({
        stage: state.stage, percent: 6,
        message: `Preparing package "${pkg.name}" (${pkg.githubRef}) with plugins: ${pkg.pluginSet.join(", ") || "core only"}...`,
      });
      zipPath = path.join(tmpRoot, "slate-release.zip");
      cleanups.push(zipPath);

      const rel = await resolveReleaseZip({
        outPath: zipPath,
        pluginSet: pkg.pluginSet,
        ref: pkg.githubRef,
      });
      if (!rel.ok) { state.percent = 6; return await fail(new Error(rel.message), "RESOLVE"); }
      state.warnings.push(...rel.warnings);
      state.percent = 20;
      await emit({
        stage: state.stage, percent: state.percent, message: rel.message,
        releaseSource: rel.source, removedPlugins: rel.removedPlugins, warnings: state.warnings,
      });

      /* ── 2. DEPLOY: installer first, then the application files ────── */
      state.stage = "DEPLOY";
      await emit({
        stage: state.stage, percent: 24,
        message: `Uploading the installer to ${site.path}...`,
      });
      const pushed = await pushInstaller(target, token);
      if (!pushed.ok) { state.percent = 24; return await fail(new Error(pushed.message), "DEPLOY"); }
      state.percent = 28;
      await emit({ stage: state.stage, percent: state.percent, message: pushed.message });

      await emit({
        stage: state.stage, percent: 32,
        message: `Copying application files (${rel.entries || "?"} files) to your server — this can take a few minutes...`,
      });
      const dep = await targetDeployFiles({ target, localZipPath: zipPath, handshakeToken: token, commitSha: rel.sha || pkg.githubRef });
      if (!dep.ok) { state.percent = 32; return await fail(new Error(dep.message), "DEPLOY"); }
      state.percent = 55;
      await emit({ stage: state.stage, percent: state.percent, message: dep.message });
      await updateOrder(lic.orderId!, { progressPercent: 55, progressStage: "DEPLOYED" }).catch(() => {});

      /* ── 2b. PAIR: lock the agent to this site's token ─────────────── */
      // A freshly uploaded auth.php has no .slate_agent_config.json yet, so it
      // accepts any token. Pairing writes token_hash + master_host, which both
      // secures the agent and lets activate.php discover the Master URL.
      //
      // This MUST succeed before CONFIG/INSTALL: the installer verifies the token
      // against the same token_hash, so an unpaired or stale-paired agent answers
      // 401 to every install call. It used to be a warning only, which produced a
      // "completed" run whose installer had actually rejected everything.
      // The client's BROWSER must be able to reach this address, so a loopback
      // URL is never acceptable — it would resolve to the customer's own machine
      // and produce an unusable "Failed to fetch" on their activation page.
      const masterRes = resolveMasterOrigin(req.url);
      if (!masterRes.origin) {
        state.percent = 57;
        return await fail(new Error(masterRes.message), "DEPLOY");
      }
      const masterOrigin = masterRes.origin;
      const hs = await handshakeEndpoint(target, token, masterOrigin);
      if (!hs.ok) {
        state.percent = 57;
        return await fail(
          new Error(
            `Could not pair the agent with its access token (${hs.message}). ` +
            `Everything after this step is authenticated with that token, so the install would be rejected with 401. ` +
            `Run "Repair files" to re-place the agent, then retry.`
          ),
          "DEPLOY"
        );
      }
      await emit({ stage: "DEPLOY", percent: state.percent, message: hs.message });

      /* ── 3. CONFIG: .env (DB + URL + secrets + LICENSE_KEY) + rules ── */
      state.stage = "CONFIG";
      await emit({ stage: state.stage, percent: 60, message: "Writing your database configuration and license key..." });

      const dbPassword = order?.dbPassEncrypted ? decryptSecret(order.dbPassEncrypted) : "";
      if (!order?.dbName || !order?.dbUser) {
        state.percent = 60;
        return await fail(
          new Error("No database was created for this site (the order has no dbName/dbUser)."),
          "CONFIG"
        );
      }

      // APP_SECRET / CRON_SECRET are generated once and reused on every retry:
      // rotating them would invalidate sessions and every HMAC-signed value.
      let appSecret = order.appSecretEncrypted ? decryptSecret(order.appSecretEncrypted) : "";
      let cronSecret = order.cronSecretEncrypted ? decryptSecret(order.cronSecretEncrypted) : "";
      if (!appSecret) appSecret = crypto.randomBytes(32).toString("hex");
      if (!cronSecret) cronSecret = crypto.randomBytes(32).toString("hex");
      if (!order.appSecretEncrypted || !order.cronSecretEncrypted) {
        await updateOrder(lic.orderId!, {
          appSecretEncrypted: encryptSecret(appSecret),
          cronSecretEncrypted: encryptSecret(cronSecret),
        }).catch(() => {});
      }

      const cfg = await targetWriteConfig({
        target,
        credentials: {
          db_name: order.dbName,
          db_user: order.dbUser,
          db_password: dbPassword,
          db_host: order.dbHost || "localhost",
        },
        newSiteUrl: site.domain,
        handshakeToken: token,
        fixPermissions: true,
        extraEnv: {
          APP_URL: site.domain,
          APP_SECRET: appSecret,
          CRON_SECRET: cronSecret,
          MCP_GATEWAY_ENABLED: "0",
          TENANT_ID: "1",
          DB_CHARSET: "utf8mb4",
          LICENSE_KEY: rawKey,
        },
        restrictions: pkg.restrictions || [],
      });
      if (!cfg.ok) { state.percent = 60; return await fail(new Error(cfg.message), "CONFIG"); }
      state.percent = 70;
      await emit({ stage: state.stage, percent: state.percent, message: cfg.message, warnings: state.warnings });

      /* ── 4. INSTALL: migrations + admin account + package plugins ──── */
      state.stage = "INSTALL";
      await emit({ stage: state.stage, percent: 74, message: "Creating your database tables and admin account..." });

      const inst = await runAppInstall(target, token, {
        admin_email: order.contactEmail,
        admin_name: order.contactName,
        // Frictionless default: the billing email IS the first password.
        // The installer hashes it; customer changes it after first login.
        admin_password: order.contactEmail,
        plugins: pkg.pluginSet || [],
      });
      if (!inst.ok) { state.percent = 74; return await fail(new Error(inst.message), "INSTALL"); }
      if (Array.isArray(inst.data?.warnings)) state.warnings.push(...inst.data.warnings);
      state.percent = 90;
      await emit({
        stage: state.stage, percent: state.percent,
        message: inst.data?.message || "Application installed.",
        plugins: inst.data?.plugins, migrations: inst.data?.migrations, warnings: state.warnings,
      });

      /* ── 5. VERIFY: agent + installer status + site HTTP ───────────── */
      state.stage = "VERIFY";
      const live = await verifyTargetLiveness({ target });
      const st = await getAppInstallStatus(target, token);
      if (st.ok && st.data?.db_ok === false) {
        state.percent = 92;
        return await fail(
          new Error(`Your site cannot reach its database: ${st.data.db_error || "unknown reason"}`),
          "INSTALL"
        );
      }
      state.percent = 96;
      await emit({
        stage: state.stage, percent: state.percent,
        message: `${live.message}${st.ok ? ` Installer reports ${st.data?.migrations?.applied ?? "?"} migrations applied.` : ""}`,
        warnings: state.warnings,
      });

      /* ── 6. COMPLETE ───────────────────────────────────────────────── */
      if (lic.orderId) {
        await updateOrder(lic.orderId, {
          status: "completed", progressPercent: 100, progressStage: "COMPLETE", error: undefined,
        });
      }
      await updateLicense(lic.id, { last_seen_at: new Date().toISOString() }).catch(() => {});
      await updateSite(site.id, {
        status: "ONLINE", lastDeployedAt: new Date().toISOString(), licenseStatus: "ACTIVE",
      });

      state.percent = 100;
      await emit({
        stage: "COMPLETE", percent: 100, done: true,
        message: "Install complete. Your Slate site is live.",
        loginUrl: `${site.domain.replace(/\/+$/, "")}/admin/`,
        siteUrl: site.domain,
        plugins: pkg.pluginSet,
        warnings: state.warnings,
      });
    } catch (err: any) {
      await fail(err);
    } finally {
      clearInterval(heartbeat);
      await cleanupTemp([zipPath]).catch(() => {});
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      try { await writer.close(); } catch { /* ignore */ }
    }
  })();

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // CORS on the STREAM as well: the customer browser reads this cross-origin,
      // so without these headers the reader throws before the first event.
      ...CORS_STREAM_HEADERS,
    },
  });
}

