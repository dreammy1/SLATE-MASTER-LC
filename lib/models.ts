/**
 * SLATE DevOps OS — Domain Model
 *
 * Pure type declarations only: no runtime logic, no I/O, no dependencies.
 *
 * These types were previously declared inline at the top of `lib/storage.ts`,
 * which meant every consumer that needed a single interface (e.g. a React page
 * wanting `Site`) also pulled in `fs/promises`, the seed catalogue and all five
 * domains of persistence code. Splitting them out means the UI can import the
 * shape of a Site without dragging the storage engine into the client bundle,
 * and the repositories can depend on the model instead of the other way round.
 *
 * ── Dependency direction (Dependency Inversion Principle) ────────────────────
 *
 *     models.ts   ← no imports
 *        ↑
 *     repositories / persistence (depend on the model)
 *        ↑
 *     api routes (depend on the facade)
 *
 * Nothing here may import from repositories or persistence — that would invert
 * the dependency and re-create the cycle this file exists to break.
 */

/* ── Sites ───────────────────────────────────────────────────────────────── */

export interface Site {
  id: string;
  domain: string;
  path: string;
  framework: string;
  status: "ONLINE" | "DEPLOYING" | "OFFLINE" | "ERROR";
  dbStatus: "CONNECTED" | "DISCONNECTED" | "UNLINKED";
  dbSize: string;
  latency: string;
  lastCommit: string;
  repo: string;
  handshakeToken: string;
  webhookSecret: string;
  lastDeployedAt: string;
  createdAt: string;
  cpanelLinked?: boolean;
  licenseId?: string;
  licenseStatus?: "ACTIVE" | "EXPIRED" | "SUSPENDED" | "REVOKED" | "NONE" | "OFFLINE";
  package_id?: string;
  /** Master-pushed remote access mode (agent .env SLATE_ACCESS_MODE). */
  remoteAccess?: "full" | "readonly";
  remoteAccessUpdatedAt?: string;
  /** Last values reported by the live agent (cached for the client list). */
  agentVersion?: string;
  coreVersion?: string;
  activePlugins?: string[];
  lastHealthAt?: string;
  lastHealthStatus?: string;
}

/* ── Databases ───────────────────────────────────────────────────────────── */

export interface DatabaseItem {
  id: string;
  name: string;
  user: string;
  password?: string;
  host: string;
  port: number;
  mode: "mysql" | "cpanel";
  size: string;
  tablesCount: number;
  status: "ACTIVE" | "IDLE" | "ERROR";
  linkedSiteId: string | null;
  provisionedAt?: string | null;
  lastTested?: string | null;
  createdAt: string;
}

/* ── Deployments ─────────────────────────────────────────────────────────── */

export interface DeploymentRecord {
  id: string;
  siteId: string;
  domain: string;
  repo: string;
  commitSha: string;
  actor: string;
  status: "BUILDING" | "SUCCESS" | "FAILED";
  duration: string;
  timestamp: string;
  logs: string[];
}

/* ── Settings ────────────────────────────────────────────────────────────── */

export interface Settings {
  githubTokenEncrypted: string;
  githubUsername: string;
  githubAvatar: string;
  autoSyncInterval: number;
  notifyOnDeploy: boolean;
  stripeSecretKeyEncrypted?: string;
  stripeWebhookSecret?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPassEncrypted?: string;
  smtpFrom?: string;
  smtpEncryption?: string;
}

/* ── Migrations ──────────────────────────────────────────────────────────── */

export interface ServerEndpoint {
  serverName: string;
  cpanelHost: string;
  cpanelPort?: number;
  cpanelUser: string;
  cpanelApiToken: string;
  fileManagerPath: string;
  siteUrl: string;
  dbHost: string;
  dbName: string;
  dbUser: string;
  dbPass: string;
  handshakeToken?: string;
  token?: string;
}

export interface MigrationJobMeta {
  srcZipPaths?: Record<string, string>;
  srcSqlPaths?: Record<string, string>;
  tgtSqlPaths?: Record<string, string>;
  tgtCredentials?: Array<{ index: number; db_name: string; db_user: string; db_password: string; db_host?: string }>;
  [key: string]: any;
}

export interface MigrationJob {
  id: string;
  title: string;
  source: ServerEndpoint;
  destination: ServerEndpoint;
  targets?: ServerEndpoint[];
  options: {
    syncFiles: boolean;
    syncDatabase: boolean;
    replaceDomainUrls: boolean;
    fixFilePermissions: boolean;
  };
  status: "IDLE" | "TESTING" | "READY" | "RUNNING" | "COMPLETED" | "FAILED";
  progress: number;
  totalFiles: number;
  transferredFiles: number;
  totalDbTables: number;
  transferredDbTables: number;
  currentStep: string;
  logs: Array<{ timestamp: string; message: string; type: "info" | "success" | "warn" | "error" }>;
  createdAt: string;
  completedAt?: string;
  error?: string;
  _meta?: MigrationJobMeta;
}

/* ── Packages / Orders / Licences ────────────────────────────────────────── */

export interface RestrictionRule {
  match: string;
  mode: "block" | "readonly";
}

export interface PackagePricing {
  monthly_cents: number;
  yearly_cents: number;
  lifetime_cents: number;
  currency: string;
  stripe_price_monthly?: string;
  stripe_price_yearly?: string;
  stripe_price_lifetime?: string;
}

export interface Package {
  id: string;
  slug: string;
  name: string;
  description: string;
  is_active: boolean;
  sort_order: number;
  pluginSet: string[];
  restrictions: RestrictionRule[];
  pricing: PackagePricing;
  githubRef: string;
  createdAt: string;
  updatedAt?: string;
}

export type BillingCycle = "monthly" | "yearly" | "lifetime";
export type PayMethod = "stripe" | "manual_bank" | "manual_cod" | "manual_custom";
export type OrderStatus =
  | "draft" | "pending_payment" | "pending_review" | "paid"
  | "bootstrap_running" | "bootstrap_done"
  | "install_running" | "completed" | "failed" | "cancelled";

export interface Order {
  id: string;
  package_id: string;
  billing_cycle: BillingCycle;
  siteUrl: string;
  base_path: string;
  fileManagerPath: string;
  /** Full hosting panel origin as typed by the customer, e.g. https://cpanel.client.com:2083 */
  hostingServerUrl: string;
  cpanelHost: string;
  cpanelUser: string;
  cpanelApiTokenEncrypted: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  payMethod: PayMethod;
  status: OrderStatus;
  stripe_session_id?: string;
  receipt_url?: string;
  siteId?: string;
  licenseId?: string;
  progressPercent: number;
  progressStage: string;
  error?: string;
  /** Persisted by bootstrap phase A so full-install can reuse the same DB. */
  dbName?: string;
  dbUser?: string;
  dbPassEncrypted?: string;
  dbHost?: string;
  agentUploaded?: boolean;
  /** Generated once per site so retries never rotate APP_SECRET/CRON_SECRET. */
  appSecretEncrypted?: string;
  cronSecretEncrypted?: string;
  licenseKeyLast4?: string;
  /** Set when the customer changed their own data from /pricing or the bookmarked order page. */
  clientEditedAt?: string;
  clientEditCount?: number;
  notes?: string;
  /**
   * Purchase-time server verification.
   *
   * Purchases NEVER depend on the host answering correctly at checkout time —
   * a typo, an expired token, or a firewall that wakes up mid-order must not
   * burn the sale. So the order is always created, and the cPanel probe result
   * is recorded honestly here instead of aborting the purchase:
   *   "verified"  → the probe passed, automation can run
   *   "unchecked" → no probe could be trusted yet (e.g. transient render)
   *   "needs_help"→ the probe failed; money is safe, support fixes the login
   */
  serverVerified?: "verified" | "unchecked" | "needs_help";
  /** The exact probe result kept for support (never a reason to refuse money). */
  serverCheckMessage?: string;
  /**
   * cPanel account resource panel (Databases, Disk Usage, File Usage, …) captured
   * BEFORE and AFTER the automation ran.
   *
   * Present so the dashboard can show server-reported proof of what the setup
   * changed — "1 / 2 databases, 214.55 MB / 20 GB disk" — instead of asking the
   * customer for a screenshot. Best-effort: a host that does not expose
   * ResourceUsage simply has no snapshot and nothing else is affected.
   */
  healthBefore?: any;
  healthAfter?: any;
  createdAt: string;
  updatedAt?: string;
}

export type LicenseStatus = "trial" | "active" | "expired" | "suspended" | "revoked" | "cancelled";

export interface LicenseRecord {
  id: string;
  key_hash: string;
  key_last4: string;
  /**
   * The RAW key, encrypted at rest — set when the key is issued so the Master
   * console can show it again later.
   *
   * `key_hash` is one-way, so without this the key was genuinely unrecoverable
   * after issue: the console could only ever show ****1234 and support had to
   * rotate the key to help a client who had lost it. Storing it encrypted (and
   * never exposing it on public endpoints) makes a "show key" toggle possible
   * without weakening the license check, which still uses the hash.
   */
  key_encrypted?: string;
  key_signature: string;
  domain: string;
  package_id: string;
  package_slug: string;
  billing_cycle: BillingCycle;
  status: LicenseStatus;
  starts_at: string;
  expires_at: string | null;
  activation_limit: number;
  activation_count: number;
  replaces_license_id?: string;
  siteId?: string;
  orderId?: string;
  last_seen_at?: string;
  createdAt: string;
  updatedAt?: string;
}

/* ── Root document ───────────────────────────────────────────────────────── */

export interface StorageSchema {
  sites: Site[];
  databases: DatabaseItem[];
  deployments: DeploymentRecord[];
  settings: Settings;
  migrations: MigrationJob[];
  packages: Package[];
  orders: Order[];
  licenses: LicenseRecord[];
}