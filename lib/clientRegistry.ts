import {
  getOrder,
  getOrders,
  getLicenses,
  getLicense,
  getSites,
  getSite,
  getPackage,
  updateOrder,
  updateLicense,
  updateSite,
  deleteOrder,
  deleteLicense,
  deleteSite,
  deleteDeploymentsForSite,
  addDeployment,
  type LicenseRecord,
  type Order,
  type Package,
  type ServerEndpoint,
  type Site,
} from "./storage";
import {
  calcRenewedExpiry,
  generateLicenseKey,
  hashLicenseKey,
  isExpiredStatus,
  maskLicenseKey,
  signLicensePayload,
} from "./licensing";
import { encryptSecret } from "./crypto";
import { getAuthPhpUrl } from "./githubWorkflow";
import { getAgentUrl, targetWriteConfig } from "./migrationExecutor";
import { getAppInstallStatus } from "./appInstaller";
import { decryptSecret } from "./crypto";
import { licenseIssuedMail, sendMail } from "./mailer";

/**
 * Client registry — one aggregated view per CUSTOMER.
 *
 * A "client" is the customer behind an order: the order holds everything they
 * typed in (site URL, cPanel credentials, contact details, payment status), the
 * license holds the entitlement (status + expiry + key), and the site holds the
 * live target (health, agent, plugins). Master previously showed those three in
 * three unrelated screens; this module builds the single record the
 * `/licenses` client-management console renders and edits.
 */

export type ClientAccessMode = "full" | "readonly" | "unknown";

export type ClientLicenseState = {
  id: string | null;
  status: string;
  effective: "active" | "expired" | "suspended" | "revoked" | "cancelled" | "none";
  expiresAt: string | null;
  lifetime: boolean;
  /** Whole days until expiry (negative = already expired). null = lifetime/unknown. */
  daysLeft: number | null;
  expiringSoon: boolean;
  keyLast4: string | null;
  maskedKey: string | null;
  activationCount: number;
  activationLimit: number;
  lastSeenAt: string | null;
  billingCycle: string | null;
};

export type ClientRecord = {
  id: string;
  orderId: string | null;
  siteId: string | null;
  licenseId: string | null;
  contactName: string;
  contactEmail: string;
  contactEmailMasked: string;
  contactPhone: string;
  siteUrl: string;
  fileManagerPath: string;
  cpanelHost: string;
  cpanelUser: string;
  cpanelLinked: boolean;
  packageId: string | null;
  packageName: string;
  packageSlug: string;
  pluginSet: string[];
  billingCycle: string;
  payMethod: string;
  paymentStatus: string;
  progressPercent: number;
  progressStage: string;
  siteStatus: string;
  latency: string;
  remoteAccess: ClientAccessMode;
  remoteAccessUpdatedAt: string | null;
  coreVersion: string | null;
  agentVersion: string | null;
  activePlugins: string[];
  lastHealthAt: string | null;
  lastHealthStatus: string | null;
  license: ClientLicenseState;
  createdAt: string;
  updatedAt: string | null;
};

export function maskEmail(e: string): string {
  const s = String(e || "");
  const at = s.indexOf("@");
  if (at <= 1) return s ? "***" + s.slice(Math.max(0, at)) : "";
  return s[0] + "***" + s.slice(at - 1);
}

const normUrl = (u?: string) => String(u || "").toLowerCase().replace(/\/+$/, "");

/** Effective license state incl. expiry that lapsed while status still says "active". */
export function licenseState(lic?: LicenseRecord | null): ClientLicenseState {
  if (!lic) {
    return {
      id: null, status: "none", effective: "none", expiresAt: null, lifetime: false,
      daysLeft: null, expiringSoon: false, keyLast4: null, maskedKey: null,
      activationCount: 0, activationLimit: 0, lastSeenAt: null, billingCycle: null,
    };
  }
  const lifetime = !lic.expires_at;
  const rawStatus = String(lic.status || "none");
  const expired = isExpiredStatus(lic.status as any, lic.expires_at);
  const effective: ClientLicenseState["effective"] = expired
    ? "expired"
    : rawStatus === "trial"
      ? "active"
      : (["active", "suspended", "revoked", "cancelled"].includes(rawStatus)
        ? (rawStatus as ClientLicenseState["effective"])
        : "none");
  const daysLeft = lifetime
    ? null
    : Math.ceil((new Date(lic.expires_at as string).getTime() - Date.now()) / 86_400_000);
  return {
    id: lic.id,
    status: rawStatus,
    effective,
    expiresAt: lic.expires_at,
    lifetime,
    daysLeft,
    expiringSoon: daysLeft !== null && daysLeft >= 0 && daysLeft <= 7,
    keyLast4: lic.key_last4 || null,
    maskedKey: lic.key_last4 ? maskLicenseKey(`${lic.key_last4}`) : null,
    activationCount: Number(lic.activation_count || 0),
    activationLimit: Number(lic.activation_limit || 0),
    lastSeenAt: lic.last_seen_at || null,
    billingCycle: lic.billing_cycle || null,
  };
}

/** ServerEndpoint-shaped target for the shared agent executor helpers. */
export function siteTarget(site: Site): ServerEndpoint {
  return {
    serverName: site.domain,
    cpanelHost: "",
    cpanelUser: "",
    cpanelApiToken: "",
    fileManagerPath: site.path,
    siteUrl: site.domain,
    dbHost: "",
    dbName: "",
    dbUser: "",
    dbPass: "",
    handshakeToken: site.handshakeToken,
  } as ServerEndpoint;
}

/** POST any agent action with the site's handshake token (never exposes the token). */
export async function agentCall(
  site: Site,
  action: string,
  extra: Record<string, unknown> = {},
  timeoutMs = 20_000
): Promise<{ ok: boolean; data: any; error: string }> {
  const agentUrl = getAuthPhpUrl(site.domain, site.path);
  if (!agentUrl) return { ok: false, data: null, error: "No agent URL could be built for this site." };
  try {
    const res = await fetch(`${agentUrl}?action=${encodeURIComponent(action)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Slate-Token": site.handshakeToken },
      body: JSON.stringify({ action, token: site.handshakeToken, ...extra }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data: any = {};
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 400) }; }
    if (!res.ok || data?.error) {
      return { ok: false, data, error: data?.error || `Agent HTTP ${res.status}.` };
    }
    return { ok: true, data, error: "" };
  } catch (err: any) {
    return { ok: false, data: null, error: err?.message || "Agent unreachable." };
  }
}

export type SiteOverview = {
  ok: boolean;
  partial: boolean;
  message: string;
  agentUrl: string;
  agentVersion: string | null;
  supportedActions: string[];
  coreVersion: string | null;
  accessMode: ClientAccessMode;
  restrictionRules: Array<{ match: string; mode: string }>;
  plugins: Array<{ slug: string; name: string; version: string | null; status: string; active: boolean }>;
  license: any;
  phpVersion: string | null;
  serverSoftware: string | null;
  raw?: any;
};

/**
 * Live "what is actually on the server" probe.
 *
 * Prefers the v3.2.0 `site_overview` action (core version + plugin list +
 * access mode). When the client still runs an older auth.php the call is
 * rejected with "Unknown action"; we then fall back to `diagnostics` and flag
 * the answer as partial so the UI can tell the operator to re-upload the agent
 * instead of silently showing nothing.
 */
export async function readSiteOverview(site: Site): Promise<SiteOverview> {
  const agentUrl = getAuthPhpUrl(site.domain, site.path) || getAgentUrl(site.domain, site.path);
  const base: SiteOverview = {
    ok: false, partial: false, message: "", agentUrl,
    agentVersion: null, supportedActions: [], coreVersion: null, accessMode: "unknown",
    restrictionRules: [], plugins: [], license: null, phpVersion: null, serverSoftware: null,
  };

  const overview = await agentCall(site, "site_overview");
  if (overview.ok) {
    const d = overview.data || {};
    return {
      ...base,
      ok: true,
      message: d.message || "Live server overview received.",
      agentVersion: d.agent_version || null,
      supportedActions: Array.isArray(d.supported_actions) ? d.supported_actions : [],
      coreVersion: d.core_version || null,
      accessMode: d.access_mode === "readonly" || d.access_mode === "full" ? d.access_mode : "unknown",
      restrictionRules: Array.isArray(d.restriction_rules) ? d.restriction_rules : [],
      plugins: Array.isArray(d.plugins) ? d.plugins : [],
      license: d.license || null,
      phpVersion: d.php_version || null,
      serverSoftware: d.server_software || null,
      raw: d,
    };
  }

  const diag = await agentCall(site, "diagnostics");
  if (!diag.ok) {
    return { ...base, message: overview.error || diag.error || "Agent unreachable." };
  }
  const d = diag.data || {};
  const stale = /unknown action/i.test(String(overview.error || ""));
  return {
    ...base,
    partial: true,
    message: stale
      ? "This site runs an older agent (no site_overview). Core version + plugin list need a fresh auth.php upload."
      : `Overview unavailable (${overview.error || "agent error"}); showing diagnostics only.`,
    agentVersion: d.agent_version || null,
    supportedActions: Array.isArray(d.supported_actions) ? d.supported_actions : [],
    phpVersion: d.capabilities?.php_version || null,
    serverSoftware: d.server_software || null,
    raw: d,
  };
}

export type ClientHealth = {
  checkedAt: string;
  http: { ok: boolean; statusCode: number | null; latencyMs: number | null; error: string | null };
  agent: { reachable: boolean; message: string; version: string | null; capabilities: any };
  installer: {
    reachable: boolean; message: string; installed: boolean | null; db_ok: boolean | null;
    migrationsApplied: number | null; licenseKeySet: boolean | null;
  };
  overview: SiteOverview;
};

/** Live site health: public HTTP + agent diagnostics + headless installer status. */
export async function readClientHealth(site: Site): Promise<ClientHealth> {
  const siteUrl = site.domain.startsWith("http") ? site.domain : `https://${site.domain}`;
  const started = Date.now();
  let ok = false;
  let statusCode: number | null = null;
  let error: string | null = null;
  let latencyMs: number | null = null;
  try {
    const res = await fetch(siteUrl, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(3_500) });
    statusCode = res.status;
    ok = res.status >= 200 && res.status < 500;
    latencyMs = Date.now() - started;
    if (!ok) error = `HTTP ${res.status}`;
  } catch (err: any) {
    error = err?.message || "request failed";
    latencyMs = Date.now() - started;
  }

  const diag = await agentCall(site, "diagnostics", {}, 12_000);
  const inst = await getAppInstallStatus(siteTarget(site), site.handshakeToken);
  const overview = await readSiteOverview(site);

  const health: ClientHealth = {
    checkedAt: new Date().toISOString(),
    http: { ok, statusCode, latencyMs, error },
    agent: {
      reachable: diag.ok,
      message: diag.ok
        ? `Agent online (${diag.data?.status || "READY"}) | ${diag.data?.capabilities?.php_version || "PHP ?"}`
        : diag.error,
      version: diag.data?.agent_version || null,
      capabilities: diag.data?.capabilities || null,
    },
    installer: {
      reachable: inst.ok,
      message: inst.message,
      installed: inst.ok ? Boolean(inst.data?.installed) : null,
      db_ok: inst.ok ? Boolean(inst.data?.db_ok) : null,
      migrationsApplied: inst.ok ? Number(inst.data?.migrations?.applied ?? 0) : null,
      licenseKeySet: inst.ok ? Boolean(inst.data?.license_key_set) : null,
    },
    overview,
  };

  await updateSite(site.id, {
    status: ok ? "ONLINE" : "OFFLINE",
    latency: latencyMs != null ? `${latencyMs}ms` : site.latency,
    lastHealthAt: health.checkedAt,
    lastHealthStatus: ok ? "ONLINE" : "OFFLINE",
    agentVersion: overview.agentVersion || health.agent.version || site.agentVersion,
    coreVersion: overview.coreVersion || site.coreVersion,
    activePlugins: overview.plugins.length ? overview.plugins.filter((p) => p.active).map((p) => p.slug) : site.activePlugins,
    remoteAccess: overview.accessMode !== "unknown" ? overview.accessMode : site.remoteAccess,
  }).catch(() => null);

  return health;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Aggregation: one ClientRecord per customer (order-first, orphan sites too)
 * ──────────────────────────────────────────────────────────────────────────── */

function resolveLinks(order: Order, licenses: LicenseRecord[], sites: Site[]) {
  const license =
    licenses.find((l) => l.id === order.licenseId) ||
    licenses.find((l) => l.orderId === order.id) ||
    licenses.find((l) => normUrl(l.domain) === normUrl(order.siteUrl)) ||
    null;
  const site =
    sites.find((s) => s.id === order.siteId) ||
    (license?.siteId ? sites.find((s) => s.id === license.siteId) : undefined) ||
    sites.find((s) => normUrl(s.domain) === normUrl(order.siteUrl)) ||
    null;
  return { license, site: site || null };
}

export function clientFromParts(
  order: Order,
  license: LicenseRecord | null,
  site: Site | null,
  pkg: Package | null
): ClientRecord {
  const lic = licenseState(license);
  return {
    id: order.id,
    orderId: order.id,
    siteId: site?.id || null,
    licenseId: license?.id || null,
    contactName: order.contactName || "",
    contactEmail: order.contactEmail || "",
    contactEmailMasked: maskEmail(order.contactEmail || ""),
    contactPhone: order.contactPhone || "",
    siteUrl: order.siteUrl || site?.domain || "",
    fileManagerPath: order.fileManagerPath || site?.path || "",
    cpanelHost: order.cpanelHost || "",
    cpanelUser: order.cpanelUser || "",
    cpanelLinked: Boolean(order.cpanelApiTokenEncrypted),
    packageId: order.package_id || null,
    packageName: pkg?.name || "Unknown package",
    packageSlug: pkg?.slug || "",
    pluginSet: pkg?.pluginSet || [],
    billingCycle: order.billing_cycle || "",
    payMethod: order.payMethod || "",
    paymentStatus: order.status,
    progressPercent: Number(order.progressPercent || 0),
    progressStage: order.progressStage || "",
    siteStatus: site?.status || "UNKNOWN",
    latency: site?.latency || "--",
    remoteAccess: site?.remoteAccess || "unknown",
    remoteAccessUpdatedAt: site?.remoteAccessUpdatedAt || null,
    coreVersion: site?.coreVersion || null,
    agentVersion: site?.agentVersion || null,
    activePlugins: site?.activePlugins || [],
    lastHealthAt: site?.lastHealthAt || null,
    lastHealthStatus: site?.lastHealthStatus || null,
    license: lic,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt || null,
  };
}

function clientFromSite(site: Site, license: LicenseRecord | null, pkg: Package | null): ClientRecord {
  const lic = licenseState(license);
  return {
    id: site.id,
    orderId: null,
    siteId: site.id,
    licenseId: license?.id || null,
    contactName: "",
    contactEmail: "",
    contactEmailMasked: "",
    contactPhone: "",
    siteUrl: site.domain,
    fileManagerPath: site.path,
    cpanelHost: "",
    cpanelUser: "",
    cpanelLinked: Boolean(site.cpanelLinked),
    packageId: site.package_id || pkg?.id || null,
    packageName: pkg?.name || "Unlinked",
    packageSlug: pkg?.slug || "",
    pluginSet: pkg?.pluginSet || [],
    billingCycle: lic.billingCycle || "",
    payMethod: "",
    paymentStatus: "unlinked",
    progressPercent: 0,
    progressStage: "",
    siteStatus: site.status,
    latency: site.latency,
    remoteAccess: site.remoteAccess || "unknown",
    remoteAccessUpdatedAt: site.remoteAccessUpdatedAt || null,
    coreVersion: site.coreVersion || null,
    agentVersion: site.agentVersion || null,
    activePlugins: site.activePlugins || [],
    lastHealthAt: site.lastHealthAt || null,
    lastHealthStatus: site.lastHealthStatus || null,
    license: lic,
    createdAt: site.createdAt,
    updatedAt: null,
  };
}

export type ClientListResult = {
  clients: ClientRecord[];
  totals: {
    clients: number;
    active: number;
    expiringSoon: number;
    expired: number;
    awaitingPayment: number;
    failedSetup: number;
  };
};

/** Every customer Master knows about — orders first, then sites nobody ordered. */
export async function listClients(query?: string): Promise<ClientListResult> {
  const [orders, licenses, sites] = await Promise.all([getOrders(), getLicenses(), getSites()]);
  const pkgIds = new Set<string>();
  orders.forEach((o) => o.package_id && pkgIds.add(o.package_id));
  sites.forEach((s) => s.package_id && pkgIds.add(s.package_id));
  const pkgMap = new Map<string, Package | null>();
  await Promise.all(Array.from(pkgIds).map(async (id) => { pkgMap.set(id, (await getPackage(id)) || null); }));

  const claimedSiteIds = new Set<string>();
  const clients: ClientRecord[] = [];

  for (const order of orders) {
    const { license, site } = resolveLinks(order, licenses, sites);
    if (site) claimedSiteIds.add(site.id);
    clients.push(clientFromParts(order, license, site, pkgMap.get(order.package_id) || null));
  }
  for (const site of sites) {
    if (claimedSiteIds.has(site.id)) continue;
    const license = licenses.find((l) => l.siteId === site.id) || null;
    clients.push(clientFromSite(site, license, site.package_id ? pkgMap.get(site.package_id) || null : null));
  }

  clients.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const q = String(query || "").trim().toLowerCase();
  const filtered = q
    ? clients.filter((c) =>
        [c.id, c.orderId, c.contactName, c.contactEmail, c.siteUrl, c.packageName, c.packageSlug, c.license.keyLast4, c.siteId]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
      )
    : clients;

  return {
    clients: filtered,
    totals: {
      clients: clients.length,
      active: clients.filter((c) => c.license.effective === "active").length,
      expiringSoon: clients.filter((c) => c.license.expiringSoon).length,
      expired: clients.filter((c) => c.license.effective === "expired").length,
      awaitingPayment: clients.filter((c) => c.paymentStatus === "pending_review" || c.paymentStatus === "pending_payment").length,
      failedSetup: clients.filter((c) => c.paymentStatus === "failed").length,
    },
  };
}

export type ClientDetail = {
  client: ClientRecord;
  order: any;
  license: any;
  site: any;
  package: Package | null;
  health: ClientHealth | null;
};

/** Full client record for the detail drawer: every stored field + optional live probe. */
export async function getClientDetail(id: string, opts: { live?: boolean } = {}): Promise<ClientDetail | null> {
  const [licenses, sites, order] = await Promise.all([getLicenses(), getSites(), getOrder(id)]);

  let license: LicenseRecord | null = null;
  let site: Site | null = null;
  let resolvedOrder: Order | null = order || null;

  if (order) {
    const links = resolveLinks(order, licenses, sites);
    license = links.license;
    site = links.site;
  } else {
    site = sites.find((s) => s.id === id) || null;
    license = site
      ? licenses.find((l) => l.siteId === site!.id) || licenses.find((l) => l.id === site!.licenseId) || null
      : licenses.find((l) => l.id === id) || null;
    if (!site && license?.siteId) site = sites.find((s) => s.id === license.siteId) || null;
    if (!resolvedOrder && license?.orderId) resolvedOrder = (await getOrder(license.orderId)) || null;
    if (!site && !resolvedOrder && !license) return null;
  }

  const packageId = resolvedOrder?.package_id || site?.package_id || license?.package_id || "";
  const pkg = packageId ? (await getPackage(packageId)) || null : null;

  let health: ClientHealth | null = null;
  if (opts.live && site) health = await readClientHealth(site);
  const freshSite: Site | null = site && health ? ((await getSite(site.id)) || site) : site;

  const client: ClientRecord =
    resolvedOrder
      ? clientFromParts(resolvedOrder, license, freshSite, pkg)
      : clientFromSite(freshSite as Site, license, pkg);

  return {
    client,
    order: resolvedOrder
      ? { ...resolvedOrder, cpanelApiTokenEncrypted: resolvedOrder.cpanelApiTokenEncrypted ? "***" : "" }
      : null,
    license: license ? { ...license, key_hash: `${license.key_hash.slice(0, 8)}...`, key_encrypted: undefined } : null,
    site: freshSite ? { ...freshSite, handshakeToken: "***", webhookSecret: "***" } : null,
    package: pkg,
    health,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Remote operations: config push (access mode + license key) + key rotation
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Push config to the client's live app through the agent's write_config action.
 * Used for the remote access mode (SLATE_ACCESS_MODE), restriction rules and the
 * LICENSE_KEY after a rotation. Never throws: the caller shows the message.
 */
export async function writeClientConfig(params: {
  site: Site;
  order: Order | null;
  extraEnv?: Record<string, string>;
  restrictions?: Array<{ match: string; mode: string }>;
  fixPermissions?: boolean;
}) {
  const { site, order, extraEnv, restrictions } = params;
  const dbPassword = order?.dbPassEncrypted ? decryptSecret(order.dbPassEncrypted) : "";
  return targetWriteConfig({
    target: siteTarget(site),
    credentials: {
      db_name: order?.dbName || "",
      db_user: order?.dbUser || "",
      db_password: dbPassword,
      db_host: order?.dbHost || "localhost",
    },
    newSiteUrl: site.domain,
    handshakeToken: site.handshakeToken,
    fixPermissions: params.fixPermissions ?? false,
    extraEnv,
    restrictions,
  });
}

/**
 * Remote access mode.
 *  - full     → the package's normal rules are restored (they only bite after expiry)
 *  - readonly → every request is read-only on the client ("*" rule + SLATE_ACCESS_MODE)
 * The mode is stored on the site so the console shows what was last pushed.
 */
export async function setRemoteAccess(params: {
  site: Site;
  order: Order | null;
  pkg: Package | null;
  mode: "full" | "readonly";
}) {
  const { site, order, pkg, mode } = params;
  const restrictions = mode === "readonly"
    ? [{ match: "*", mode: "readonly" }]
    : (pkg?.restrictions || []);

  const res = await writeClientConfig({
    site,
    order,
    extraEnv: { SLATE_ACCESS_MODE: mode },
    restrictions,
  });

  if (res.ok) {
    await updateSite(site.id, {
      remoteAccess: mode,
      remoteAccessUpdatedAt: new Date().toISOString(),
    }).catch(() => null);
    await addDeployment({
      siteId: site.id,
      domain: site.domain,
      repo: order?.package_id || "remote-access",
      commitSha: `access-${mode}`,
      actor: "master-ops",
      status: "SUCCESS",
      duration: "0.0s",
      logs: [`[${new Date().toLocaleTimeString()}] Remote access mode pushed: ${mode}`, res.message],
    }).catch(() => null);
  }

  return { ok: res.ok, mode, message: res.message, restrictions };
}

/** New key for the SAME license row (no new entitlement) + push it to the client. */
export async function rotateLicenseKey(params: {
  order: Order;
  license: LicenseRecord;
  site: Site | null;
  pkg: Package | null;
  notify?: boolean;
}) {
  const { order, license, site, pkg } = params;
  const rawKey = generateLicenseKey();
  const expiresAt = calcRenewedExpiry(license.expires_at, license.billing_cycle);

  const updated = await updateLicense(license.id, {
    key_hash: hashLicenseKey(rawKey),
    key_last4: rawKey.slice(-4),
    // Same reason as at issue time: keep the raw key recoverable for support.
    key_encrypted: encryptSecret(rawKey),
    key_signature: signLicensePayload(license.domain, pkg?.slug || license.package_slug, expiresAt),
    status: "active",
    starts_at: new Date().toISOString(),
    expires_at: expiresAt,
    activation_count: 0,
  });
  await updateOrder(order.id, { licenseKeyLast4: rawKey.slice(-4) }).catch(() => null);

  let pushed = false;
  let pushMessage = "No site linked yet — the client activates the new key from the activation page.";
  if (site) {
    const res = await writeClientConfig({ site, order, extraEnv: { LICENSE_KEY: rawKey } });
    pushed = res.ok;
    pushMessage = res.message;
  }

  const warnings: string[] = [];
  if (params.notify !== false) {
    const mail = await sendMail(licenseIssuedMail(order.contactEmail, rawKey, license.domain, pkg?.name || license.package_slug, expiresAt));
    if (!mail.ok) warnings.push(`Email not sent (${mail.message}). Copy the key from this screen.`);
  }

  return {
    ok: true,
    key: rawKey,
    masked: maskLicenseKey(`${rawKey.slice(-4)}`),
    expiresAt,
    license: updated,
    pushed,
    pushMessage,
    warnings,
  };
}

/** Read the client's live license status and sync the Master registry + site badge. */
export async function syncLicenseFromAgent(site: Site) {
  const res = await agentCall(site, "license_status");
  if (!res.ok) {
    await updateSite(site.id, { licenseStatus: "OFFLINE" }).catch(() => null);
    return { ok: false, message: res.error, license: null, siteLicenseStatus: "OFFLINE" };
  }
  const lic = res.data?.license || {};
  const map: Record<string, string> = {
    active: "ACTIVE", trial: "ACTIVE", expired: "EXPIRED", suspended: "SUSPENDED", revoked: "REVOKED",
  };
  const status = map[String(lic.status)] || "NONE";
  await updateSite(site.id, { licenseStatus: status as any }).catch(() => null);
  if (site.licenseId) {
    await updateLicense(site.licenseId, { last_seen_at: new Date().toISOString() }).catch(() => null);
  }
  return {
    ok: true,
    message: `Agent reports license ${String(lic.status || "unknown")} (${status}).`,
    license: lic,
    siteLicenseStatus: status,
  };
}

/**
 * Reveal the RAW license key for a client — Master console only.
 *
 * AUDIT NOTE: this is deliberately the only place a raw key leaves storage, and
 * it is never reachable from the public order page. It exists because losing a
 * key used to force a full rotation (which invalidates the key the client may
 * already have installed), when the honest answer is "show them the key again".
 *
 * Returns a clear reason when the key predates encrypted storage, so the UI can
 * offer a rotation instead of pretending it failed.
 */
export async function revealLicenseKey(id: string): Promise<{
  ok: boolean;
  key?: string;
  maskedKey?: string;
  expiresAt?: string | null;
  message: string;
  needsRotation?: boolean;
}> {
  const detail = await getClientDetail(id, {});
  if (!detail) return { ok: false, message: "Client not found." };
  if (!detail.license) return { ok: false, message: "No license has been issued for this client yet." };

  const lic = await getLicense(detail.license.id);
  if (!lic) return { ok: false, message: "License record not found." };

  if (!lic.key_encrypted) {
    return {
      ok: false,
      needsRotation: true,
      maskedKey: lic.key_last4 ? maskLicenseKey(lic.key_last4) : undefined,
      message:
        "This license was issued before keys were stored recoverably, so the full key cannot be shown. Rotate the key to get a new one.",
    };
  }

  try {
    const key = decryptSecret(lic.key_encrypted);
    if (!key) throw new Error("empty");
    await addDeployment({
      siteId: lic.siteId || detail.site?.id || "",
      domain: lic.domain,
      repo: "client-console",
      commitSha: "reveal-key",
      actor: "master-ops",
      status: "SUCCESS",
      duration: "0.0s",
      logs: [`[${new Date().toLocaleTimeString()}] License key revealed in the Master console.`],
    }).catch(() => null);
    return {
      ok: true,
      key,
      maskedKey: maskLicenseKey(key),
      expiresAt: lic.expires_at,
      message: "License key revealed.",
    };
  } catch {
    return {
      ok: false,
      needsRotation: true,
      message: "The stored key could not be decrypted (it may have been written with a different secret). Rotate the key to issue a new one.",
    };
  }
}

/** Delete a client: the order + all its licenses always; the site only when asked. */
export async function deleteClientRecord(id: string, opts: { removeSite?: boolean } = {}) {
  const order = await getOrder(id);
  const directSite = await getSite(id);
  const site = order?.siteId ? (await getSite(order.siteId)) || directSite : directSite;
  const licenses = await getLicenses();

  const licenseIds = new Set<string>();
  for (const l of licenses) {
    if (l.id === id || l.orderId === id || (site && l.siteId === site.id) || (order?.licenseId && l.id === order.licenseId)) {
      licenseIds.add(l.id);
    }
  }
  if (!order && !site && licenseIds.size === 0) return null;

  let licensesRemoved = 0;
  for (const lid of Array.from(licenseIds)) licensesRemoved += (await deleteLicense(lid)) ? 1 : 0;

  let siteDeleted = false;
  if (site) {
    await deleteDeploymentsForSite(site.id);
    if (opts.removeSite) {
      siteDeleted = await deleteSite(site.id);
    } else {
      await updateSite(site.id, { licenseId: undefined, licenseStatus: "NONE" as any }).catch(() => null);
    }
  }

  const orderDeleted = order ? await deleteOrder(order.id) : false;
  return {
    orderId: order?.id || null,
    siteId: site?.id || null,
    siteDeleted,
    orderDeleted,
    licensesRemoved,
  };
}

