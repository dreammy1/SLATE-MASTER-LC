SLATE Licensing + Purchase Auto-Deploy — Full Architecture, End-to-End Workflow, Development Plan & Testing Suite
Master Dashboard v2.4.0 (Next.js 14) <-> Slate Core PHP (Phase 1E) via auth.php v3.0.1

This is a plan-only deliverable — no code changed. All file/line references below are verified from your current tree.

1. Current-State Findings (what we reuse vs what is missing)
1.1 Master Dashboard today
Area	File	Verified behavior
Store	lib/storage.ts	Site{id,domain,path,framework,status,dbStatus,latency,repo,handshakeToken,webhookSecret}, DatabaseItem, DeploymentRecord, Settings{githubTokenEncrypted}, MigrationJob, ServerEndpoint{siteUrl,fileManagerPath,dbHost/dbName/dbUser/dbPass,handshakeToken}. Persisted in data/db.json. No Package/Order/License entities.
Executor	lib/migrationExecutor.ts	verifyEndpoint, handshakeEndpoint, sourcePackageFiles, sourceDumpDatabase, sanitizeSqlDumpFile, applySqlReplacements, targetProvisionDatabase, targetDeployFiles, targetImportDatabase, targetWriteConfig({db_host,db_name,db_user,db_password,site_url,base_path,fix_permissions}), verifyTargetLiveness, cleanupTemp. targetWriteConfig already sends site_url + base_path from migrationPaths.publicPathFromFilePath(). Extension point for LICENSE_KEY.
Scaffold streaming	components/CreateRepoModal.tsx:68-116 + app/api/github/scaffold/route.ts	NDJSON application/x-ndjson events {percent,currentFile,totalFiles,currentFileName,stage,message,done,error} consumed with getReader()+TextDecoder. Reuse exactly for both 0–100% bars.
Crypto	lib/crypto.ts	AES-256-GCM encryptSecret/decryptSecret (iv:authTag:data), key from ENCRYPTION_SECRET. Use for cPanel tokens + Stripe secrets, never log raw.
CI/CD	lib/githubWorkflow.ts	generateDeployWorkflow() injects deploy.yml → curl -F action=deploy → auth.php then POST /api/deploy/webhook.
Agent contract	public/auth.php:260-265	$SLATE_SUPPORTED_ACTIONS = [diagnostics,ping,handshake,cpanel_setup,database_scan,database_create,database_probe,deploy,package_files,download_package,dump_database,sql_import,write_config] agent 3.0.1. Stale check in app/api/migrations/test/route.ts:7-20. New license_* actions bump to 3.1.0 + extend this list.
Sites API	app/api/sites/route.ts	POST {domain,path,framework,repo} auto-creates slate_live_* + slate_sec_*. License fields to be added here.
1.2 Slate Core PHP today (Phase 1E)
Area	File	Verified behavior
Plans	db/migrations/0015_platform_plans.php	platform_plans{slug,name,description,is_active,sort_order,limits JSON(max_users,max_customers)} + plan_entitlements{plan_id,feature_key,enabled} where feature_key = real plugin slug (booking,coaching,forms,membership,stripe-payment,...). Seeded Free/Starter/Pro/Enterprise. PlanService::save/list/entitlementsFor/delete owns it. This is the server-side half of your Package Builder — Master mirrors it + adds pricing.
License table	db/migrations/0017_licenses.php	licenses{tenant_id,license_key_hash CHAR64 (SHA256 only, never raw),plan_id,status[trial/active/expired/suspended/revoked/cancelled],issued_at,starts_at,expires_at NULL=lifetime,activation_limit/count,metadata JSON,last_validated_at,revoke_reason}. History via audit_log target=license#id, no parallel log table.
License engine	src/Services/Licensing/LicenseService.php	issue() → SLT-XXXX-XXXX-XXXX-XXXX (random_bytes, unambiguous alphabet) shown ONCE, effectiveStatus() lazy-expiry (active/trial past expires_at → expired) + last_validated_at touch, sweepExpired() on daily_cron. Docblock: "no public validation endpoint in this phase, admin-provisioned only" + "expiry never destroys data".
Gate	src/Services/Licensing/EntitlementService.php	5-layer canAccess(tenantId,featureKey): 1 Installed? PluginLoader::isActive / 2 Platform allowed (=same this phase) / 3 Licensed? status ∈ [trial,active,none] / 4 Plan entitled? plan_entitlements contains key / 5 Tenant enabled? setting entitlement.$key.enabled. none (no license) = unrestricted for BC. Denial silent → hide nav + 403. Core admin (users/roles/settings/dashboard) never routed through it → stays available. This is why expiry today only hides plugins, not settings — your read-only + per-URL restriction is a new layer on top.
Admin pattern	slate/admin/*.php, docs/09-Roadmap/a3-core-reviews/auth.md:45	Every page opens require config.php → Auth::require() → Auth::requirePerm(...). ~160 call sites. New gate goes in same position, or preferably once via config.php keyed on SCRIPT_NAME (zero per-file edits).
Error UX pattern	slate/includes/error_page.php	slate_render_error(status,title,msg) + slate_maintenance_gate() (branded card, DB-safe, admin bypass). Clone for slate_license_gate().
Tenant link	0014 tenant_profiles + 0016 plan_id	tenant_profiles{tenant_id,owner_*,lifecycle_status,plan_id}. License→tenant→plan chain.
Gap summary: Master has deploy power but no commerce/license model. Slate has license model but no remote authority, no domain binding, no heartbeat, no per-URL restriction map, no renew page.

2. Target Architecture

┌─ PUBLIC ─────────────────────────────────────┐
│ Master /pricing (SSR, no auth)               │
│  Package 1: core+booking+membership+stripe   │
│  Package 2: core+coaching+forms+stripe+mcp   │
│  [Monthly|Yearly|Lifetime] → /orders/new     │
└──────────────┬───────────────────────────────┘
               v
┌─ MASTER (authority, Next.js 14) ─────────────┐
│ lib/store += packages,orders,licenses        │
│ app/(pricing,orders,licenses) + api/*        │
│ lib/licensing.ts: keygen(HMAC)+verify        │
│ GitHub (private monorepo, tag v1.x)          │
│ SMTP mailer (new) + Stripe webhook (new)     │
└──┬───────────────┬───────────────┬───────────┘
   │ cPanel FileMan│ agent HTTPS   │ DB/API
   v               v               v
┌─ CLIENT cPanel ─┐ ┌─ CLIENT app ─────────────┐
│ Fileman::upload │ │ auth.php v3.1.0          │
│ auth.php +      │ │ activate.php + billing.php│
│ activate.php    │ │ LicenseClient.php + guard │
│ (Phase A)       │ │ core+package plugins (B)  │
└─────────────────┘ └──────────────────────────┘
Authority rule: Master is source of truth (licenses registry). Client holds enforced cache (licenses row + .env LICENSE_KEY). Sync via heartbeat (6h + on admin login). Master wins on conflict. Client works offline GRACE_HOURS=72 then degrades — never hard-deletes data.

Key format (keep Slate's): SLT-XXXX-XXXX-XXXX-XXXX (random_bytes, alphabet ABCDEFGHJKLMNPQRSTUVWXYZ23456789). Store only sha256(raw) both sides. Sign payload HMAC_SHA256(domain|plan_slug|expires_at, MASTER_LICENSE_SECRET) for offline verify. Raw shown once + mailed once.

3. Data Model
3.1 Master data/db.json additions (lib/storage.ts)

Package {
  id, slug, name, description, is_active, sort_order,
  pluginSet: string[],              // e.g. ["booking","membership","stripe-payment"]
  restrictions: RestrictionRule[],  // §5
  pricing: { monthly_cents, yearly_cents, lifetime_cents, currency, stripe_price_monthly?, stripe_price_yearly?, stripe_price_lifetime? },
  githubRef: string,                // tag/branch e.g. "v1.4.0"
  createdAt, updatedAt
}
RestrictionRule { match: string, mode: "block"|"readonly" }
// match = path suffix, `*` wildcard. Ex: "plugins/booking/admin/new.php", "plugins/stripe-payment/admin/*", "admin/settings.php"

Order {
  id, package_id, billing_cycle: "monthly"|"yearly"|"lifetime",
  siteUrl, base_path, fileManagerPath, cpanel: {host,user,apiTokenEncrypted},
  contact: {name,phone,email}, payMethod: "stripe"|"manual_bank"|"manual_cod"|"manual_custom",
  status: "draft"|"pending_payment"|"pending_review"|"paid"|"bootstrap_running"|"bootstrap_done"|"install_running"|"completed"|"failed"|"cancelled",
  stripe_session_id?, receipt_url?, siteId?, licenseId?,
  progress: {phase: "A"|"B", percent: number, stage: string},
  createdAt, updatedAt
}

LicenseRecord {
  id, key_hash: string, key_last4: string,
  domain: string, package_id, billing_cycle,
  status: "trial"|"active"|"expired"|"suspended"|"revoked"|"cancelled",
  starts_at, expires_at: string|null,   // null = lifetime
  activation_limit, activation_count,
  replaces_license_id?: string,
  siteId?, orderId?, tenant_id?: number,
  last_seen_at?, last_heartbeat?,
  createdAt, updatedAt
}
// + Site += { licenseId?: string, licenseStatus?: "ACTIVE"|"EXPIRED"|"SUSPENDED"|"REVOKED"|"NONE"|"OFFLINE", package_id?: string }
Seed packages from Slate 0015 (Free/Starter/Pro/Enterprise) + your two sales packages. restrictions default: block admin/settings.php, admin/plugins.php, admin/users.php, admin/roles.php + package plugin */new.php, */settings.php, */*edit*, */*delete*, */*import* on expiry; allowlist lists (appointments.php, customers.php, members.php, contact_forms.php + ?id= view).

3.2 Slate DB migrations (new, additive, MigrationRunner ordered)
0019_license_domains.php — licenses.domain VARCHAR(255) NULL + idx, licenses.billing_cycle ENUM + NULL, licenses.replaces_license_id INT NULL, licenses.package_slug VARCHAR(64) NULL. Backfill domain from metadata->domain where present. Required: current 0017 has no domain column — remote binding impossible without this.
0020_package_restrictions.php — package_restrictions{id, package_slug, match, mode ENUM(block,readonly), sort_order} + seed defaults per §5. Cached to settings key license.restrictions_json on deploy for fast gate reads.
No change to platform_plans/plan_entitlements schema — Master pushes plan rows via sql_import seed on Phase B; PlanService untouched.
3.3 Slate new/changed PHP
File	Change
src/Services/Licensing/LicenseClient.php (new)	validate(): {status, expires_at, grace} — checks effectiveStatus + domain==HTTP_HOST + HMAC + heartbeat due → POST Master /api/licenses/heartbeat. Writes last_validated_at. Returns ok/expired/grace/suspended/revoked. Never throws to caller (fail-open to grace, fail-closed after grace).
includes/license_guard.php (new)	slate_license_guard(?string $script=null): void — resolves suffix match against package_restrictions, calls LicenseClient::validate(), enforces: active/trial → pass; expired → block matches → 302 billing.php?restricted=..., readonly matches → define SLATE_READONLY=1 + block POST (405 + redirect); suspended/revoked → 302 billing.php?locked=1 (full block except billing/login). Always allow login.php, logout.php, billing.php, activate.php.
config.php (1-line add)	After PluginLoader::boot(), require_once license_guard.php; slate_license_guard($_SERVER['SCRIPT_NAME'] ?? null); — single choke point, no 160-file edit.
admin/billing.php (new, public-when-expired)	Shows package, domain, expires, status, [Renew Same Plan] [Change Package] → Master checkout prefilled, [Activate Renewal Key] form → POST Master /api/licenses/activate → flips local row active + expires_at → redirect admin/index.php. Uses slate_render_error styling. Must be in guard allowlist.
activate.php (new, root, pre-install mini-app ~150 lines)	Phase-B entry when full app not yet deployed: shows package/domain/expires, key input → calls Master activate → streams Phase-B NDJSON (same reader as CreateRepoModal) → [Go to Admin Login]. No DB dependency beyond agent config.
List pages (tweak, not rewrite)	plugins/booking/admin/appointments.php, customers.php, membership/.../members.php, admin/contact_forms.php: wrap mutation buttons if (!defined('SLATE_READONLY')), reject POST when SLATE_READONLY with flash Read-only — renew license. Views/pagination/filters untouched.
admin/index.php	Banner when not active: License expired — read-only · [Renew Plan → billing.php], using existing enabledFeaturesFor() pattern.
public/auth.php → v3.1.0	Add license_status, license_set_key, license_enforce + extend $SLATE_SUPPORTED_ACTIONS, diagnostics.supported_actions, agent_version 3.1.0. See §4.
cron.php	Keep daily_cron → sweepExpired(); add heartbeat sweep (Master side polls, not client cron).
4. auth.php v3.1.0 Contract (Master ↔ Agent)
All require authenticateAgent() (X-Slate-Token or body token), never log raw key.


GET  ?action=diagnostics
  += supported_actions [...,"license_status","license_set_key","license_enforce"],
     agent_version "3.1.0", license: {status, expires_at, domain} (best-effort, never fails diagnostics)

POST ?action=license_status {}
  → 200 {status, expires_at, domain, plan_slug, entitlements:[...], last_validated_at}
  Reads licenses(forTenant) + tenant_profiles.plan_id + PlanService::entitlementsFor. DB-safe try/catch.

POST ?action=license_set_key {key, domain?, plan_slug?}
  → validates SLT- format, sha256 lookup or HMAC verify, writes .env LICENSE_KEY (via write_config path), activates local row, returns {status, expires_at}
  Used by activate.php + renew activation. Rate-limit: reuse login_attempts pattern (10/min/IP).

POST ?action=license_enforce {action: suspend|revoke|activate|extend, reason?, days?}
  → calls LicenseService::setStatus/extend locally, clears session cache marker, audit_logs. Returns new status.
  Used by Master Suspend/Reactivate/Revoke/Extend buttons. Master then updates its own registry.
Master executor additions (lib/migrationExecutor.ts): getLicenseStatus(target), setLicenseKey(target,key), enforceLicense(target,action) — all safeFetch(withActionQuery(agentUrl,action), {X-Slate-Token}) + parseJsonSafe, same timeouts as targetWriteConfig (45s). CRITICAL_MIGRATION_ACTIONS in app/api/migrations/test/route.ts extended with the 3 new actions so stale-agent detection covers licensing.

5. Per-Package Restriction Model (you edit, no code)
Stored on Package.restrictions, synced to client package_restrictions table on Phase B + cached JSON. Evaluated in slate_license_guard() only when license not active:


[
  {"match": "admin/settings.php", "mode": "block"},
  {"match": "admin/plugins.php", "mode": "block"},
  {"match": "admin/users.php", "mode": "block"},
  {"match": "admin/roles.php", "mode": "block"},
  {"match": "plugins/booking/admin/new.php", "mode": "block"},
  {"match": "plugins/booking/admin/settings.php", "mode": "block"},
  {"match": "plugins/stripe-payment/admin/*", "mode": "block"},
  {"match": "plugins/booking/admin/appointments.php", "mode": "readonly"},
  {"match": "plugins/booking/admin/customers.php", "mode": "readonly"},
  {"match": "plugins/membership/admin/members.php", "mode": "readonly"},
  {"match": "admin/contact_forms.php", "mode": "readonly"}
]
Semantics: block → 302 billing.php?restricted=<script> (renew funnel). readonly → GET renders, POST/PUT/DELETE rejected. Master UI: repeater rows {match text, mode select, test path button} + Save → sync to selected sites (calls write_config-style restrictions push). Suffix match covers /slate/ vs /public_html/slate/ installs; * = prefix wildcard within suffix.

6. End-to-End Workflows
6.1 Purchase — Phase A: Order → Bootstrap (auth.php only) 0→100%

Client: /pricing → pick P1 Monthly → /orders/new (siteUrl, path select, cPanel host/user/token + [Test]) → /checkout (name/phone/email, Stripe|Bank|COD|Custom) → Submit
Master POST /api/orders {…} → validate URL+base_path (migrationPaths), encrypt cPanel token (crypto.ts), create order{draft}
  Stripe: Checkout Session → webhook stripe/payment_succeeded (verify Stripe-Signature, idempotency stripe_session_id) → order{paid}
  Manual: order{pending_review} + receipt upload → admin Approve → order{paid}
→ POST /api/deploy/bootstrap {orderId} (NDJSON stream, same reader as CreateRepoModal):
  5%  validate cPanel (Fileman::list) + normalize siteUrl/base_path
  20% database_create (provisionCpanel via lib/dbCreator.ts; reuse if exists)
  40% Fileman::upload auth.php v3.1.0 + activate.php → {fileManagerPath} (0644/0755 note on fail; fallback manual-upload card + Retry)
  60% handshake (pair slate_live_* token → Site row + order.siteId)
  80% license issue (generateKey + HMAC, store sha256 only, order.licenseId) + SMTP mail raw key once
  100% → success screen: URL + masked key ****XXXX + Copy + [Open My Site → activate.php]
Failure branches: cPanel fail → order{failed} + exact UAPI message + Retry (no key issued, no charge captured for Stripe auth-capture mode). Upload blocked → manual card. Mail fail → show key once on screen + Resend (audit-logged, rate-limited).

6.2 Activation — Phase B: Key → Full App 0→100%

Client opens https://his-domain/slate/activate.php → sees package/domain/expires → pastes SLT- key → [Activate & Install]
→ POST Master /api/licenses/activate {key, domain}: sha256 lookup + domain match + status active/trial + activation_count<limit → increment, return {package, githubRef, dbCreds ref}
→ POST /api/deploy/full-install {orderId} (NDJSON):
  10% resolve package → downloadGithubTarball(private repo, githubRef) + filter plugins/* to package.pluginSet (exclude others at zip time)
  35% targetDeployFiles(agent, zip) [existing]
  60% targetImportDatabase(schema.sql + 0001..0019 + package plugins/*/install.sql) + applySqlReplacements(old→new) [existing]
  80% targetWriteConfig(.env APP_URL,DB_*,LICENSE_KEY + .htaccess rebase + .installed restore — fixed last session) + push package_restrictions seed [existing + 1 extra payload]
  100% verifyTargetLiveness [existing] → [Go to Admin Login → /slate/admin/]
Client: install.php gate sees .installed → login, not installer. License already active.
6.3 Expiry → Read-Only → Renew → Re-activate

daily_cron sweepExpired() OR lazy effectiveStatus() → status expired
→ guard: restricted URLs 302 billing.php?restricted=…; readonly pages render with SLATE_READONLY (POST blocked); banner on dashboard
→ billing.php [Renew Same Plan] → Master /checkout?renewalOf=… prefilled → pay (Stripe|manual) → new LicenseRecord{replaces_license_id} + mail new key once
→ billing.php [Activate Renewal Key] → /api/licenses/activate → agent license_set_key → local row active + expires_at=+cycle → 302 admin/index.php flash "License renewed"
→ Upgrade P1→P2 → full-install with new pluginSet delta (add/remove plugins + plan_entitlements reseed)
Lifetime: expires_at NULL → sweep skips, guard never fires, billing shows "Lifetime — no renewal needed"
6.4 Operate (Master Licenses page)
Table Domain|Package|Key ****XXXX|Status|Expires|Activations|Last seen|Actions: Suspend/Reactivate/Revoke/Extend/Rotate key/Push restrictions/Redeploy/Open site. Each = license_enforce agent call + registry update + addDeployment audit log. Telemetry tab += license health cards. Terminal += slate license <domain> (status output).

7. Development Plan (ordered, no working flow touched)
Milestone 0 — Scaffolding (0.5d): lib/licensing.ts (keygen SLT-, sha256, HMAC sign/verify, expiry calc monthly/yearly/lifetime, mask ****XXXX), lib/packages.ts seed (2 sales packages mapped to real plugin slugs), Master SMTP mailer (lib/mailer.ts, env SMTP_*, audit-logged, no key in subject).

M1 — Catalogue + Orders UI (2d): lib/storage.ts += Package/Order/LicenseRecord + CRUD helpers (same getDb/saveDb pattern); app/pricing/page.tsx (public cards + cycle toggle), app/orders/new + checkout + order/[id] (NDJSON progress reader cloned from CreateRepoModal), app/api/orders/* (POST create, POST approve, GET progress), app/api/packages/*. Manual payment path fully working; Stripe stubbed.

M2 — Bootstrap Phase A (2d): app/api/deploy/bootstrap/route.ts (NDJSON: validate→db→upload→handshake→issue→mail), cPanel Fileman::upload helper (lib/cpanel.ts, encrypted token, 0644/0755 handling + manual fallback), POST /api/licenses/issue, GET /api/sites/[id]/license (poll license_status). Depends on M0+M1.

M3 — Agent + Client enforcement (3d): public/auth.php v3.1.0 (3 actions + diagnostics), slate/activate.php, slate/includes/license_guard.php + config.php hook, slate/admin/billing.php, slate/db/migrations/0019 + 0020, readonly tweaks on 4 list pages + dashboard banner. Deploy agent via existing download-agent route. Test with 0019/0020 on staging clone first.

M4 — Full install Phase B (2d): app/api/deploy/full-install/route.ts (NDJSON: tarball+plugin filter → deploy → import → write_config+LICENSE_KEY+restrictions → verify), POST /api/licenses/activate, plugin allow-list filter in tarball builder. Reuses migrationExecutor — no changes to existing migration routes.

M5 — Renew + Operate (2d): renewal checkout (renewalOf), license_enforce executor + Master buttons, TerminalDrawer slate license, telemetry cards, repair-url extended to push restrictions.

M6 — Stripe (1.5d): Checkout Session + app/api/stripe/webhook (signature verify, idempotency), price IDs per package×cycle. Manual path remains.

Total ~13 dev-days, each milestone independently demoable. Migration flow (/migrations/*, redeploy, scaffold) untouched except additive executor functions.

8. Testing Suite
8.1 Automated (add, don't replace)
Level	Location	Cases
Unit (Master, vitest new)	lib/licensing.test.ts	key format/uniqueness (10k loop), sha256 never equals raw, HMAC verify/tamper, expiry calc (+30d/+1y/null), mask, restriction suffix+wildcard matcher (20 cases incl. /slate/ vs /public_html/slate/)
Unit (Slate, existing tests/unit/run.php harness)	tests/unit/LicenseGuardTest.php	guard matrix: active→pass, expired+block→302 billing, expired+readonly GET→pass+SLATE_READONLY, expired+readonly POST→405, suspended→302 locked, allowlisted login/billing/activate→pass, no-license BC→pass
Integration (Slate, needs MySQL per tests/README.md)	tests/integration/LicenseFlowTest.php	0019/0020 migrate up/down, issue→effectiveStatus→sweepExpired→expired, entitlement chain (licensed+plan+enabled), renewal extend-from-expiry, lifetime null skip
API (Master, new tests/api/*.test.ts with mocked fetch)	orders/licenses/bootstrap/full-install	order validation (bad URL/cPanel → 400, no key issued), idempotent Stripe webhook (double delivery → 1 license), activate domain-mismatch → 403, activation_limit enforced, manual approve → same pipeline as Stripe
Agent contract	tests/agent/license-actions.test.ts (live staging agent)	diagnostics.supported_actions includes 3 new, license_status/set_key/enforce round-trip, stale-agent warning when pointed at old 3.0.1 file
8.2 E2E (staging cPanel required)
Happy monthly: pricing→server→Stripe-test→Phase A 100% (assert DB exists, agent handshake, mail received, success screen) → activate key → Phase B 100% → login → package plugins present, others absent → admin/billing.php shows Active.
Manual COD: same but pending_review → Approve → Phase A.
Expiry: set expires_at=-1h (Master test button) → reload booking/new.php → 302 billing, appointments.php → renders, New hidden, POST → rejected, settings.php → 302 → renew → new key → activate → full access, replaces_license_id linked.
Upgrade: P1→P2 renew → delta deploy adds coaching,forms, removes booking files safely (backup ~/slate-backups/ first per STUDIO_BUILD_BRIEF).
Offline grace: block Master egress → admin login works 72h with banner → after grace → restricted. Restore → heartbeat recovers.
Subfolder vs root: run full flow once at /public_html/slate and once at /public_html (assert .htaccess RewriteBase + ErrorDocument rebased — regression from last session's fix).
8.3 Security / negative
Raw key never in db.json/agent config/logs/URL (grep suite); sha256 only. HMAC tamper → reject. Domain reuse of key on 2nd domain → reject + audit. license_enforce without valid X-Slate-Token → 401. Rate-limit key attempts (10/min/IP). Stripe signature bypass → 400. cPanel token at rest encrypted (crypto.ts), in transit only over HTTPS.

8.4 Manual QA checklist (per release)
[ ] pricing renders both packages × 3 cycles with correct plugin lists [ ] cPanel Test before payment [ ] Phase A bar reaches 100 with 5 stage messages [ ] mail contains key once [ ] activate→Phase B→login [ ] expiry→readonly lists viewable, mutations blocked [ ] blocked URL→billing→renew→activate→access [ ] Master Suspend→client locked in <60s, Reactivate→restored [ ] old 3.0.1 agent shows stale warning, new 3.1.0 passes migrations/test.