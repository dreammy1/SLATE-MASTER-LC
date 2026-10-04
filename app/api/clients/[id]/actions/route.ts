import { NextRequest, NextResponse } from "next/server";
import {
  addDeployment,
  getLicense,
  getOrder,
  getPackage,
  getSite,
  updateLicense,
  type LicenseRecord,
  type Order,
  type Package,
  type Site,
} from "@/lib/storage";
import {
  agentCall,
  getClientDetail,
  revealLicenseKey,
  rotateLicenseKey,
  setRemoteAccess,
  syncLicenseFromAgent,
} from "@/lib/clientRegistry";
import { cpanelTestConnection, decryptCpanelToken } from "@/lib/cpanel";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { randomBytes } from "crypto";
import { updateOrder } from "@/lib/storage";
import { targetWriteConfig } from "@/lib/migrationExecutor";
import { repairAgentFiles } from "@/lib/agentUpload";
import { checkAgent } from "@/lib/agentUpload";
import { handshakeEndpoint } from "@/lib/migrationExecutor";
import { resolveMasterOrigin } from "@/lib/masterOrigin";
import { getAuthPhpUrl } from "@/lib/githubWorkflow";
import { executeClientPushUpdate } from "@/lib/clientUpdate";
import type { FolderCandidate } from "@/lib/migrationPaths";

/**
 * POST /api/clients/[id]/actions  { action, ... }
 *
 * Remote operations the client-management console needs:
 *   remote_access  { mode: "full" | "readonly" }  push the access mode to the agent
 *   rotate_key     { notify?: boolean }           new key for the same license + push
 *   sync_license                                  read the live status from the agent
 *   license_op     { op, reason?, days? }         suspend / activate / revoke / extend
 *   test_cpanel    { cpanelApiToken? }            re-test the stored cPanel credentials
 *   repair_files   { siteUrl?, fileManagerPath?, publicSubPath?, cpanelApiToken? }
 *                                                 re-place auth.php + activate.php,
 *                                                 trying every folder/URL layout
 *   reveal_key                                    return the RAW license key (Master only)
 *
 * "Re-run bootstrap" and "Re-run full setup" both stream NDJSON, so those two
 * buttons call the existing /api/deploy/bootstrap and /api/deploy/full-install
 * stream endpoints (the console embeds the same progress readers).
 */

type Ctx = { order: Order | null; lic: LicenseRecord | null; site: Site | null; pkg: Package | null; body: any; id: string; req: NextRequest };

async function audit(site: Site | null, line: string) {
  if (!site) return;
  await addDeployment({
    siteId: site.id,
    domain: site.domain,
    repo: "client-console",
    commitSha: "console",
    actor: "master-ops",
    status: "SUCCESS",
    duration: "0.0s",
    logs: [`[${new Date().toLocaleTimeString()}] ${line}`],
  }).catch(() => null);
}

export async function POST(req: NextRequest, { params: p }: { params: Promise<{ id: string }> }) {
const params = await p;

  try {
    const body = await req.json().catch(() => ({} as any));
    const action = String(body.action || "");
    const handler = HANDLERS[action];
    if (!handler) {
      return NextResponse.json(
        { success: false, error: `Unsupported action "${action}".`, supported: Object.keys(HANDLERS) },
        { status: 400 }
      );
    }

    const detail = await getClientDetail(params.id, {});
    if (!detail) return NextResponse.json({ success: false, error: "Client not found." }, { status: 404 });

    const order = detail.order ? (await getOrder(detail.order.id)) || null : null;
    const lic = detail.license ? (await getLicense(detail.license.id)) || null : null;
    const site = detail.site ? (await getSite(detail.site.id)) || null : null;
    const pkg = detail.package || (order ? (await getPackage(order.package_id)) || null : null);

    return await handler({ order, lic, site, pkg, body, id: params.id, req });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || "Action failed." }, { status: 500 });
  }
}
/**
 * REPAIR FILES — re-place auth.php + activate.php on an EXISTING client.
 *
 * Purpose-built for the "the files went missing / the folder was wrong" case:
 * it never touches the database, the license or the application files, so it is
 * safe to press on a live site and uses no database quota. It tries every
 * plausible folder/URL layout (including an existing /public_html/booking and
 * the pretty URL https://site/booking) and stops at the first that answers.
 */
async function handleRepairFiles({ order, site, body, req }: Ctx): Promise<NextResponse> {
  const targetOrder = order;
  if (!targetOrder) {
    return NextResponse.json({ success: false, error: "This client has no order, so the cPanel credentials are unknown." }, { status: 400 });
  }

  const token = body.cpanelApiToken ? String(body.cpanelApiToken) : decryptCpanelToken(targetOrder.cpanelApiTokenEncrypted);
  if (!token) {
    return NextResponse.json({ success: false, error: "No cPanel API token stored — add one in the edit dialog first." }, { status: 400 });
  }
  if (!targetOrder.cpanelHost || !targetOrder.cpanelUser) {
    return NextResponse.json({ success: false, error: "cPanel host/user are missing on this order." }, { status: 400 });
  }

  const siteUrl = String(body.siteUrl || site?.domain || targetOrder.siteUrl || "");
  const publicSubPath = body.publicSubPath ? String(body.publicSubPath) : undefined;

  const res = await repairAgentFiles({
    creds: { host: targetOrder.cpanelHost, user: targetOrder.cpanelUser, apiToken: token },
    siteUrl,
    fileManagerPath: String(body.fileManagerPath || targetOrder.fileManagerPath || site?.path || ""),
    publicSubPath,
    // After placing the files, confirm the agent really answers on that URL —
    // this is what stops a "successful" repair that still 404s for the client.
    verifyUrl: async (c: FolderCandidate) => {
      const probe = await checkAgent(c.siteUrl, site?.handshakeToken || "", true);
      const obj = typeof probe === "object" && probe ? probe : { ok: false, message: String(probe || "agent did not answer") };
      return { ok: (obj as any).ok, message: (obj as any).message || "" };
    },
  });

  await audit(site, `repair files: ok=${res.ok} target=${res.target?.remoteDir || "?"} — ${res.message}`);

  /**
   * RE-PAIR the agent after re-placing it.
   *
   * The installer verifies the token against the hash written at handshake, so a
   * stale or missing pairing makes every later call answer 401 — a repair that
   * only copies files would leave that broken. Pairing here is what makes
   * "Repair files" actually restore a working client.
   */
  let pairing: { ok: boolean; message: string } | null = null;
  if (res.ok && site?.handshakeToken) {
    const masterRes = resolveMasterOrigin(req.url);
    if (!masterRes.origin) {
      // Without a public URL the agent would keep calling localhost, so say why
      // instead of writing an address the client can never reach.
      pairing = { ok: false, message: masterRes.message };
      await audit(site, `repair pairing skipped: ${masterRes.message}`);
    } else {
      const target = {
        siteUrl: res.target?.siteUrl || siteUrl,
        fileManagerPath: site.path,
        handshakeToken: site.handshakeToken,
      } as any;
      const hs = await handshakeEndpoint(target, site.handshakeToken, masterRes.origin);
      pairing = { ok: hs.ok, message: hs.message };
      await audit(site, `repair pairing: ok=${hs.ok} — ${hs.message}`);
    }
  }

  return NextResponse.json(
    {
      success: res.ok,
      credsOk: res.credsOk,
      message: res.ok
        ? `${res.message}${pairing ? ` Agent pairing: ${pairing.ok ? "linked to this site's token." : pairing.message}` : ""}`
        : res.message,
      warnings: res.warnings,
      steps: res.steps,
      target: res.target || null,
      attempts: res.attempts || [],
      pairing,
      agentUrl: res.target ? getAuthPhpUrl(res.target.siteUrl, res.target.remoteDir.replace(/^public_html\/?/, "")) : null,
    },
    { status: res.ok ? 200 : 502 }
  );
}

async function handleRemoteAccess({ order, site, pkg, body }: Ctx): Promise<NextResponse> {
  const mode = body.mode === "readonly" ? "readonly" : body.mode === "full" ? "full" : null;
  if (!mode) return NextResponse.json({ success: false, error: "mode must be full|readonly." }, { status: 400 });
  if (!site) return NextResponse.json({ success: false, error: "No live site linked — run bootstrap first." }, { status: 400 });

  const res = await setRemoteAccess({ site, order, pkg, mode });
  await audit(site, `remote access -> ${mode}: ${res.message}`);
  return NextResponse.json({ success: res.ok, ...res }, { status: res.ok ? 200 : 502 });
}

async function handleRotateKey({ order, lic, site, pkg, body }: Ctx): Promise<NextResponse> {
  if (!order) return NextResponse.json({ success: false, error: "This client has no order, so there is no license to rotate." }, { status: 400 });
  if (!lic) return NextResponse.json({ success: false, error: "No license has been issued for this client yet." }, { status: 400 });

  const res = await rotateLicenseKey({ order, license: lic, site, pkg, notify: body.notify !== false });
  await audit(site, `license key rotated (****${res.key.slice(-4)}) — pushed=${res.pushed}`);
  return NextResponse.json({
    success: true,
    ...res,
    message: `New key issued (****${res.key.slice(-4)}). ${res.pushMessage}`,
  });
}

async function handleSyncLicense({ site }: Ctx): Promise<NextResponse> {
  if (!site) return NextResponse.json({ success: false, error: "No live site linked." }, { status: 400 });
  const res = await syncLicenseFromAgent(site);
  return NextResponse.json(res, { status: res.ok ? 200 : 502 });
}

/**
 * CONFIG ONLY — write .env / config.php for an already-deployed client.
 *
 * For the common repair case: the files are on the server but the site 500s
 * because .env was never written. This re-runs just the configuration step (no
 * file copy, no database work), so support can fix a broken site quickly.
 */
async function handleWriteConfig({ order, site }: Ctx): Promise<NextResponse> {
  if (!order || !site) {
    return NextResponse.json({ success: false, error: "A linked site and order are required." }, { status: 400 });
  }
  if (!order.dbName || !order.dbUser) {
    return NextResponse.json({ success: false, error: "This order has no database details; run the setup first." }, { status: 400 });
  }

  const pack = await getPackage(order.package_id);
  const dbPassword = order.dbPassEncrypted ? decryptSecret(order.dbPassEncrypted) : "";

  // Reuse the same secrets so sessions and signed values survive a config repair.
  let appSecret = order.appSecretEncrypted ? decryptSecret(order.appSecretEncrypted) : "";
  let cronSecret = order.cronSecretEncrypted ? decryptSecret(order.cronSecretEncrypted) : "";
  if (!appSecret) appSecret = randomBytes(32).toString("hex");
  if (!cronSecret) cronSecret = randomBytes(32).toString("hex");
  if (!order.appSecretEncrypted || !order.cronSecretEncrypted) {
    await updateOrder(order.id, {
      appSecretEncrypted: encryptSecret(appSecret),
      cronSecretEncrypted: encryptSecret(cronSecret),
    }).catch(() => null);
  }

  const lic = site.licenseId ? await getLicense(site.licenseId) : null;

  const res = await targetWriteConfig({
    target: { siteUrl: site.domain, fileManagerPath: site.path, handshakeToken: site.handshakeToken } as any,
    credentials: {
      db_name: order.dbName,
      db_user: order.dbUser,
      db_password: dbPassword,
      db_host: order.dbHost || "localhost",
    },
    newSiteUrl: site.domain,
    handshakeToken: site.handshakeToken,
    fixPermissions: true,
    extraEnv: {
      APP_URL: site.domain,
      APP_SECRET: appSecret,
      CRON_SECRET: cronSecret,
      MCP_GATEWAY_ENABLED: "0",
      TENANT_ID: "1",
      DB_CHARSET: "utf8mb4",
    },
    restrictions: pack?.restrictions || [],
  });

  await audit(site, `write config: ok=${res.ok} — ${res.message}`);
  return NextResponse.json(
    { success: res.ok, message: res.message, details: (res as any).details || null },
    { status: res.ok ? 200 : 502 }
  );
}

async function handleLicenseOp({ lic, site, body }: Ctx): Promise<NextResponse> {
  if (!lic || !site) return NextResponse.json({ success: false, error: "A linked site and license are required." }, { status: 400 });
  const op = String(body.op || "");
  if (!["suspend", "activate", "revoke", "extend"].includes(op)) {
    return NextResponse.json({ success: false, error: "op must be suspend|activate|revoke|extend." }, { status: 400 });
  }

  let expiresAt: string | undefined = body.expires_at ? String(body.expires_at) : undefined;
  if (op === "extend" && !expiresAt) {
    const days = Math.max(1, Number(body.days || 30));
    const base = lic.expires_at && new Date(lic.expires_at).getTime() > Date.now() ? new Date(lic.expires_at) : new Date();
    base.setDate(base.getDate() + days);
    expiresAt = base.toISOString();
  }

  const agentRes = await agentCall(site, "license_enforce", {
    op,
    reason: body.reason || "Master console action",
    expires_at: expiresAt,
  });

  const statusMap: Record<string, string> = { suspend: "suspended", activate: "active", revoke: "revoked", extend: "active" };
  await updateLicense(lic.id, op === "extend" && expiresAt
    ? { expires_at: expiresAt, status: "active" }
    : { status: statusMap[op] as any });
  await audit(site, `license ${op}${expiresAt ? ` until ${expiresAt}` : ""} — agent=${agentRes.ok ? "ok" : agentRes.error}`);

  return NextResponse.json({
    success: true,
    op,
    expiresAt: expiresAt || null,
    agent: { ok: agentRes.ok, message: agentRes.ok ? "Pushed to the live server." : agentRes.error },
  });
}

/**
 * REVEAL KEY — return the raw license key so the console can show it on demand.
 * Master console only; the public order page never exposes it.
 */
async function handleRevealKey({ id }: Ctx): Promise<NextResponse> {
  const res = await revealLicenseKey(id);
  return NextResponse.json({ success: res.ok, ...res }, { status: res.ok ? 200 : 404 });
}

async function handleTestCpanel({ order, body }: Ctx): Promise<NextResponse> {  if (!order) return NextResponse.json({ success: false, error: "No order stored for this client." }, { status: 400 });
  const token = body.cpanelApiToken ? String(body.cpanelApiToken) : decryptCpanelToken(order.cpanelApiTokenEncrypted);
  if (!token) return NextResponse.json({ success: false, error: "No cPanel token stored — enter one in the edit dialog first." }, { status: 400 });
  const probe = await cpanelTestConnection({ host: order.cpanelHost, user: order.cpanelUser, apiToken: token });
  return NextResponse.json({ success: probe.ok, message: probe.message }, { status: probe.ok ? 200 : 502 });
}

async function handlePushUpdate({ order, lic, site, pkg, body }: Ctx): Promise<NextResponse> {
  const targetSite = site || (lic?.siteId ? await getSite(lic.siteId) : null);
  if (!targetSite) {
    return NextResponse.json({ success: false, error: "No live site linked to this client — cannot push update." }, { status: 400 });
  }

  const res = await executeClientPushUpdate(targetSite, pkg, {
    ref: body.ref || body.githubRef,
    plugins: Array.isArray(body.plugins) ? body.plugins : undefined,
    lic,
    actor: "master-ops",
  });

  return NextResponse.json(res, { status: res.success ? 200 : 502 });
}

const HANDLERS: Record<string, (c: Ctx) => Promise<NextResponse>> = {
  remote_access: handleRemoteAccess,
  rotate_key: handleRotateKey,
  sync_license: handleSyncLicense,
  license_op: handleLicenseOp,
  test_cpanel: handleTestCpanel,
  repair_files: handleRepairFiles,
  reveal_key: handleRevealKey,
  write_config: handleWriteConfig,
  push_update: handlePushUpdate,
};

