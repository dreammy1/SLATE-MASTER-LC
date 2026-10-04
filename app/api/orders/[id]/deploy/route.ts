import { NextRequest, NextResponse } from "next/server";
import { getOrder, getSite, getPackage, updateOrder, updateSite, addLicense } from "@/lib/storage";
import { getAuthPhpUrl } from "@/lib/githubWorkflow";
import { agentFetch, readAgentResponse } from "@/lib/agentHttp";
import { guideForStage } from "@/lib/bootstrapGuide";
import { resolveMasterOrigin } from "@/lib/masterOrigin";
import { resolveReleaseZip } from "@/lib/releaseResolver";
import { generateLicenseKey, hashLicenseKey, calcExpiry, signLicensePayload } from "@/lib/licensing";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { pushInstaller, runAppInstall, getAppInstallStatus } from "@/lib/appInstaller";
import { targetDeployFiles, targetWriteConfig, verifyTargetLiveness, cleanupTemp, handshakeEndpoint, targetProvisionDatabase } from "@/lib/migrationExecutor";
import { registerSiteForOrder } from "@/lib/siteRegister";
import { sendMail, licenseIssuedMail } from "@/lib/mailer";
import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";

// POST deploy — frictionless full-install (NDJSON 0-100%).
// CONNECT(0-10) DATABASE(10-25) DEPLOY(25-60) CONFIG(60-70)
// INSTALL(70-90) LICENSE(90-96) VERIFY+COMPLETE(96-100).
// Admin password default = billing email (hashed by slate-installer.php).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({} as any));
  const order = await getOrder(id);
  if (!order) return NextResponse.json({ success: false, error: "Order not found." }, { status: 404 });
  const okStatus = ["paid", "bootstrap_running", "failed", "bootstrap_done", "install_running"];
  if (!okStatus.includes(order.status)) {
    return NextResponse.json({ success: false, error: `Order is "${order.status}". Approve the payment first, then deploy.` }, { status: 400 });
  }
  const pkg = await getPackage(order.package_id);
  if (!pkg) return NextResponse.json({ success: false, error: "Package not found." }, { status: 400 });
  const manualMode = !order.cpanelApiTokenEncrypted;
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();
  const state = { stage: "CONNECT", percent: 0, warnings: [] as string[] };
  const heartbeat = setInterval(() => {
    writer.write(encoder.encode(JSON.stringify({ heartbeat: true, stage: state.stage, percent: state.percent }) + "\n")).catch(() => {});
  }, 10_000);
  const emit = async (data: any) => { await writer.write(encoder.encode(JSON.stringify(data) + "\n")); };
  const fail = async (err: Error, failedStage?: string) => {
    const sn = failedStage || state.stage;
    await updateOrder(id, { status: "failed", progressPercent: state.percent, progressStage: sn, error: err.message }).catch(() => {});
    await emit({ error: err.message, failedStage: sn, percent: state.percent, guide: guideForStage(sn, err.message), warnings: state.warnings });
  };
  void updateOrder(id, { status: "install_running", progressPercent: 1, progressStage: "CONNECT" }).catch(() => {});
  (async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slate-install-"));
    const zipPath = path.join(tmpRoot, "release.zip");
    try {
      const siteUrl = String(order.siteUrl || "").replace(/\/+$/, "");
      let site = order.siteId ? await getSite(order.siteId) : null;
      if (!site) {
        site = await registerSiteForOrder(order, order.package_id);
        await updateOrder(id, { siteId: site.id });
      }
      const token = site.handshakeToken;
      const target = { siteUrl, fileManagerPath: order.fileManagerPath || "/public_html", cpanelHost: order.cpanelHost || "", cpanelUser: order.cpanelUser || "", cpanelApiToken: "", handshakeToken: token } as any;
      state.stage = "CONNECT";
      await emit({ stage: state.stage, percent: 2, message: "Contacting your server…" });
      const agentUrl = getAuthPhpUrl(siteUrl, target.fileManagerPath);
      if (!agentUrl) { state.percent = 2; await fail(new Error("Site URL is missing. Fix the domain first."), "CONNECT"); return; }
      try {
        const ping = await agentFetch(`${agentUrl}?action=ping`, { method: "POST", headers: { "Content-Type": "application/json", "X-Slate-Token": token }, body: JSON.stringify({ action: "ping", token }) }, 20_000);
        const pb = await readAgentResponse(ping);
        if (!pb.isAgent) { state.percent = 5; await fail(new Error(`auth.php not reachable at ${agentUrl} (${pb.message}). Re-upload to ${target.fileManagerPath}, then retry.`), "CONNECT"); return; }
      } catch (err: any) { state.percent = 5; await fail(new Error(`Could not reach your server (${err?.message || "timeout"}). Check ${target.fileManagerPath}, then retry.`), "CONNECT"); return; }
      state.percent = 10;
      await emit({ stage: state.stage, percent: 10, message: "Agent is live. Pairing…" });
      const masterRes = resolveMasterOrigin(req.url);
      if (masterRes.origin) {
        const hs = await handshakeEndpoint(target, token, masterRes.origin);
        if (!hs.ok) state.warnings.push(`Pairing note: ${hs.message}`);
      }

      state.stage = "DATABASE";
      let dbName = order.dbName || "";
      let dbUser = order.dbUser || "";
      let dbPass = "";
      let dbHost = "localhost";
      try { if (order.dbPassEncrypted) dbPass = decryptSecret(order.dbPassEncrypted); } catch { /* keep */ }
      if (!manualMode) {
        await emit({ stage: state.stage, percent: 12, message: "Provisioning database automatically…" });
        const prov = await targetProvisionDatabase({ target, handshakeToken: token, appName: "slateapp" });
        if (!prov.ok) { state.percent = 15; await fail(new Error(prov.message), "DATABASE"); return; }
        const pc = prov.credentials || {} as any;
        dbName = pc.db_name || dbName;
        dbUser = pc.db_user || dbUser;
        dbPass = pc.db_password || dbPass;
        dbHost = pc.db_host || "localhost";
      } else {
        const mName = String(body.dbName || order.dbName || "");
        const mUser = String(body.dbUser || order.dbUser || "");
        const mPass = String(body.dbPass || "");
        if (!mName || !mUser || !mPass) { state.percent = 12; await fail(new Error("Database details missing. Create DB+user in cPanel, enter them, retry."), "DATABASE"); return; }
        dbName = mName; dbUser = mUser; dbPass = mPass; dbHost = String(body.dbHost || "localhost");
        await updateOrder(id, { dbName, dbUser, dbHost, dbPassEncrypted: encryptSecret(dbPass) }).catch(() => {});
      }
      state.percent = 25;
      await emit({ stage: state.stage, percent: 25, message: `Database ready (${dbName}).` });
      state.stage = "DEPLOY";
      await emit({ stage: state.stage, percent: 30, message: "Preparing your application files…" });
      const rel = await resolveReleaseZip({ outPath: zipPath, pluginSet: pkg.pluginSet });
      if (!rel.ok) { state.percent = 32; await fail(new Error(rel.message), "DEPLOY"); return; }
      state.warnings.push(...(rel.warnings || []));
      state.percent = 45;
      await emit({ stage: state.stage, percent: 45, message: rel.message });
      const push = await pushInstaller(target, token);
      if (!push.ok) state.warnings.push(push.message);
      const dep = await targetDeployFiles({ target, localZipPath: zipPath, handshakeToken: token, commitSha: rel.sha || "manual-install" });
      if (!dep.ok) { state.percent = 50; await fail(new Error(dep.message), "DEPLOY"); return; }
      state.percent = 60;
      await emit({ stage: state.stage, percent: 60, message: dep.message });


      state.stage = "CONFIG";
      await emit({ stage: state.stage, percent: 64, message: "Writing site configuration…" });
      let appSecret = "", cronSecret = "";
      try {
        if (order.appSecretEncrypted) appSecret = decryptSecret(order.appSecretEncrypted);
        if (order.cronSecretEncrypted) cronSecret = decryptSecret(order.cronSecretEncrypted);
      } catch { /* regenerate */ }
      if (!appSecret) appSecret = crypto.randomBytes(32).toString("hex");
      if (!cronSecret) cronSecret = crypto.randomBytes(32).toString("hex");
      await updateOrder(id, { appSecretEncrypted: encryptSecret(appSecret) }).catch(() => {});
      await updateOrder(id, { cronSecretEncrypted: encryptSecret(cronSecret) }).catch(() => {});
      const rawKey = generateLicenseKey();
      const expiresAt = calcExpiry(new Date(), order.billing_cycle);
      const cfg = await targetWriteConfig({ target, handshakeToken: token, credentials: { db_host: dbHost, db_name: dbName, db_user: dbUser, db_password: dbPass }, newSiteUrl: siteUrl, fixPermissions: true, extraEnv: { APP_SECRET: appSecret, CRON_SECRET: cronSecret, LICENSE_KEY: rawKey, PACKAGE_SLUG: pkg.slug }, restrictions: pkg.restrictions || [] });
      if (!cfg.ok) { state.percent = 66; await fail(new Error(cfg.message), "CONFIG"); return; }
      state.percent = 70;
      await emit({ stage: state.stage, percent: 70, message: cfg.message });
      state.stage = "INSTALL";
      await emit({ stage: state.stage, percent: 74, message: "Creating tables and your admin account…" });
      const inst = await runAppInstall(target, token, { admin_email: order.contactEmail, admin_name: order.contactName, admin_password: order.contactEmail, plugins: pkg.pluginSet || [] });
      if (!inst.ok) { state.percent = 78; await fail(new Error(inst.message), "INSTALL"); return; }



      if (Array.isArray(inst.data?.warnings)) state.warnings.push(...inst.data.warnings);
      state.percent = 90;
      await emit({ stage: state.stage, percent: 90, message: inst.data?.message || "Application installed.", warnings: state.warnings });
      state.stage = "LICENSE";
      const lic = await addLicense({ key_hash: hashLicenseKey(rawKey), key_last4: rawKey.slice(-4), key_encrypted: encryptSecret(rawKey), key_signature: signLicensePayload(siteUrl, pkg.slug, expiresAt), domain: siteUrl, package_id: pkg.id, package_slug: pkg.slug, billing_cycle: order.billing_cycle, status: "active", starts_at: new Date().toISOString(), expires_at: expiresAt, activation_limit: 1, activation_count: 1, siteId: site.id, orderId: id });
      await updateOrder(id, { licenseId: lic.id, licenseKeyLast4: rawKey.slice(-4) }).catch(() => {});
      await updateSite(site.id, { licenseId: lic.id, licenseStatus: "ACTIVE" }).catch(() => {});
      try {
        const mail = await sendMail(licenseIssuedMail(order.contactEmail, rawKey, siteUrl, pkg.name, expiresAt));
        if (!mail.ok) state.warnings.push("Email failed. The key is on this screen — copy it now.");
      } catch { state.warnings.push("Email skipped — the key is on this screen, copy it now."); }
      state.stage = "VERIFY";
      const live = await verifyTargetLiveness({ target });
      const st = await getAppInstallStatus(target, token);
      if (st.ok && st.data?.db_ok === false) { state.percent = 96; await fail(new Error(`Site cannot reach database: ${st.data.db_error || "unknown"}`), "INSTALL"); return; }
      await updateOrder(id, { 
        status: "completed", 
        progressPercent: 100, 
        progressStage: "COMPLETE", 
        error: undefined,
        cpanelApiTokenEncrypted: "", // Flush sensitive credentials post-deployment
        cpanelUser: "",
        cpanelHost: "",
        hostingServerUrl: ""
      }).catch(() => {});
      await updateSite(site.id, { status: "ONLINE", lastDeployedAt: new Date().toISOString(), licenseStatus: "ACTIVE" }).catch(() => {});
      state.percent = 100;
      await emit({ stage: "COMPLETE", percent: 100, done: true, message: "Install complete. Your Slate site is live.", loginUrl: `${siteUrl}/admin/login.php`, adminUser: "admin", adminPassHint: order.contactEmail, siteUrl, licenseKey: rawKey, plugins: pkg.pluginSet, warnings: state.warnings, liveness: live.message });
    } catch (err: any) { await fail(err); } finally {
      clearInterval(heartbeat);
      await cleanupTemp([zipPath]).catch(() => {});
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      try { await writer.close(); } catch { /* ignore */ }
    }
  })();

  return new Response(stream.readable, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
