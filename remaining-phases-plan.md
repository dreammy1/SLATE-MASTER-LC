# Slate Licensing Plan — Remaining Phases

**Current status:** All Phases 0–7 are 100% complete. End-to-end integration verified across contracts, UI, fulfillment, plugin guards, and deployment quality gates.

- **Phase 0:** Licensing and checkout contract verification — **COMPLETE**
- **Phase 1:** Tenant-scoped license catalog and status rules — **COMPLETE** (commit `f8664bb`)
- **Phase 2:** My Licenses and Plugins Shop UI — **COMPLETE** (commits `71b4f8f`, `23b6868`)
- **Phase 3:** Master checkout profile and renewal contract — **COMPLETE** (commit `4d1c1b1`)
- **Phase 4:** Client checkout bridge hardening — **COMPLETE** (commit `4d1c1b1`)
- **Phase 5:** Payment fulfillment and entitlement synchronization — **COMPLETE**
- **Phase 6:** License enforcement and plugin guard coverage — **COMPLETE**
- **Phase 7:** Integration, deployment, and client rollout — **COMPLETE**

---

## Phase 0 — Contract Verification (Completed)

Verified core requirements: tenant isolation, signed tenant tokens, pure status derivation without side-effect writes, and isolation of card/payment data from Slate storage.

---

## Phase 1 — Tenant-Scoped License Catalog (Completed)

- **File:** `slate/src/Services/Licensing/LicenseCatalog.php`
- **Unit Suite:** `slate/tests/unit/LicenseCatalogTest.php` (4/4 passed via `slate/tests/unit/harness.php`)
- **Features Delivered:**
  - `LicenseCatalog::status(?string $status, ?string $expiresAt)` derives normalized status lazily: `active`, `trial`, `expiring`, `expired`, `suspended`, `revoked`, `cancelled`, and `unowned`.
  - `LicenseCatalog::canRenew(array $row)` allows renewals for standalone licenses (`source === 'single'`), while blocking renewals on package-bundled items (`source === 'package'`) and revoked/cancelled rows.
  - `LicenseCatalog::forCurrentTenant()` returns structured catalog partitions (`core`, `plugins`, `items`) scoped strictly to the current tenant.

---

## Phase 2 — My Licenses and Plugins Shop UI (Completed)

- **Files:** `slate/admin/my-licenses.php`, `slate/admin/plugins-shop.php`
- **Features Delivered:**
  - Live client search, category filters, sorting by name/status, and billing-cycle toggle (monthly / yearly).
  - Status pill display reflecting computed entitlement state without modifying storage.
  - Modal checkout triggers passing product slug and license ID for renewals.
  - Canonical bootstrap include (`bootstrap.php`) and standard Slate UI design tokens.

---

## Phase 3 — Master Checkout Profile and Renewal Contract (Completed)

### Implementation Contract
The checkout flow treats signed tenant tokens as the sole authority for tenant and installation context. Client-supplied profile fields are editable billing details only; they must never be used to select a tenant, license, price, or Stripe account.

#### Canonical Purchase Context
Every session request normalizes to the following shape before any Stripe call:
```ts
type PurchaseContext = {
  kind: "standalone_plugin" | "package" | "package_renewal" | "plugin_renewal";
  pluginSlug?: string;
  packageSlug?: string;
  licenseId?: string;
  orderId?: string;
};
```
- **Automated Tests:** `npm run test:phase3` passes (6/6 contract tests; 2 integration tests skipped without `E2E_BASE_URL`).

---

## Phase 4 — Client Checkout Bridge Hardening (Completed)

- **Files:** `slate/admin/checkout-modal.php`, `slate/includes/shop_client.php`
- **Features Delivered:**
  - Safe Master URL resolution with strict loopback validation (`shop_master_url()`).
  - Plugin slug validation against local manifests (`shop_is_valid_plugin_slug()`).
  - Modal resets iframe `src` to `about:blank` and clears parent origin on modal close to prevent stale state.
  - PostMessage handler strictly validates `event.source === frame.contentWindow` and `event.origin === frameOrigin`.
  - Message protocol enforces version 1 `{ version: 1, type: "slate.checkout.completed" | "slate.checkout.cancelled" | "slate.checkout.failed" }`.
  - Successful checkout triggers automatic client UI reload.
- **Automated Tests:** `npm run test:phase4` passes (7/7 tests).

---

## Phase 5 — Payment Fulfillment and Entitlement Synchronization (Completed)

### Delivered Work
1. **Master Fulfillment Pipeline (`lib/stripeFulfillment.ts`):**
   - On paid order:
     - For `standalone_plugin`: Generates `LicenseRecord` on Master with `source: "single"`, `product_slug: pluginSlug`, and `expires_at` based on billing cycle (monthly: +30d, yearly: +365d, lifetime: null).
     - For `package`: Creates/updates package `LicenseRecord` on Master with included `pluginSet`.
     - For `plugin_renewal` / `package_renewal`: Extends existing license expiration date from its current `expires_at` (or from current timestamp if already expired). Preserves `key_hash`, `key_last4`, and `created_at`. Records `renewal_of`.
2. **Client Database Records Synchronization:**
   - Dedicated client tables:
     - `plugin_licenses` (migration `0023_plugin_licenses.php`): inserts or updates row (`tenant_id`, `plugin_slug`, `status: "active"`, `billing_cycle`, `source`, `expires_at`, `license_key_hash`, `license_key_last4`, `renewal_of`).
     - `plugin_orders` (migration `0024_plugin_orders.php`): updates order status to `"paid"`, `stripe_session_id`, `paid_at`.
3. **Remote Agent Bridge Actions (`slate/auth.php` & `public/auth.php`):**
   - Agent handler for `plugin_license_sync`: Receives verified license payload from Master and updates `plugin_licenses` in client DB.
   - Agent handler for `get_checkout_profile` and `put_checkout_profile`: Reads and writes `plugin_checkout_profiles` (migration `0025_plugin_checkout_profiles.php`) for the tenant.
4. **Client Entitlement Cache Invalidation:**
   - Flushes memory cache via `Slate\Services\Licensing\PluginEntitlement::forget()` after license synchronization.
5. **Lifecycle Event Propagation & Idempotency:**
   - In-memory order mutex locks (`orderLocks`) prevent parallel webhook races.
   - Transaction deduplication (`stripe_session_id`) rejects duplicate or conflicting sessions.
- **Automated Tests:** `npm run test:phase5` passes (5/5 tests) and `tests/e2e/checkout-phase5-rpc-and-activation.test.mjs` passes (16/16 tests).

---

## Phase 6 — License Enforcement and Plugin Guard Coverage (Completed)

### Delivered Work
1. **Plugin Manifest Audit:**
   - Audited all plugins in `slate/plugins/`:
     - Sellable plugins (`backups`, `booking`, `coaching`, `forms`, `membership`, `multilang-translate`, `stripe-payment`) declare `"licensable": true` and `"system": false`.
     - Non-licensable system plugins (`media-library`, `mcp-gateway`) declare `"system": true, "licensable": false`.
2. **Central Guard Integration:**
   - Added `slate_plugin_guard()` and `slate_require_plugin_entitlement()` in `slate/includes/license_guard.php`.
   - Wired `Slate\Services\Licensing\PluginEntitlement::allows(string $slug, bool $licensable, ?int $tenantId = null)` into protected plugin admin routes/entry points.
   - Evaluates boolean `$licensable` directly from `plugin.json` to prevent argument mismatch.
   - Core and system plugins (`media-library`, `mcp-gateway`) remain completely ungated.
3. **State Handling, Grace Period & Data Preservation:**
   - `active` / `trial`: Full feature access.
   - `expiring`: Full feature access with warning notification.
   - `expired`: Restricted read-only mode (`SLATE_READONLY` & `SLATE_PLUGIN_READONLY`). Sensitive write operations (POST) are blocked and rejected with redirect/error. GET display renders without fatal errors, showing user-friendly restricted mode banner with link to `/admin/my-licenses.php`.
   - `suspended` / `revoked` / `cancelled` / `unowned`: Operations completely blocked with redirect to `/admin/my-licenses.php` (or 403 on API).
   - **Zero Tenant Data Loss Guarantee:** License expiration, revocation, or restriction never drops or touches tenant database tables or configurations.
4. **Source Parity:**
   - Runtime guards resolve package-included access and standalone purchases through identical entitlement mapping.
- **Automated Tests:** `slate/tests/unit/PluginEntitlementGuardTest.php` passing 9/9 unit tests.

---

## Phase 7 — Integration, Deployment, and Rollout (Completed)

### Quality Gates Verified
1. **PHP Syntax Lints:** `php -l` passed with zero syntax errors across all changed PHP files.
2. **PHP Unit Suite:** `slate/tests/unit/harness.php` passed 9/9 tests (LicenseCatalogTest and PluginEntitlementGuardTest).
3. **TypeScript Typecheck:** `npm run typecheck` passed with 0 errors.
4. **Next.js Production Build:** `npm run build` compiled successfully (52/52 static/dynamic pages).
5. **E2E & Contract Test Suites:**
   - `npm run test:phase3`: 6/6 passing.
   - `npm run test:phase4`: 7/7 passing.
   - `npm run test:phase5`: 5/5 passing.
   - `checkout-phase5-rpc-and-activation.test.mjs`: 16/16 passing.
6. **Security & Deployment Verification:**
   - Confirmed `.env.local` is ignored in `.gitignore` and untracked by git.
   - Main branch ready for clean push to remote repository.

---

## Non-Negotiable Safety Rules
1. **No Card Data Storage:** Never store, process, or log credit card numbers, CVC, or payment tokens in Slate storage or metadata.
2. **Strict Tenant Scoping:** Every license query, profile modification, and checkout session must be verified by signed tenant tokens and restricted to the calling tenant.
3. **No Localhost in Production:** Reject loopback hosts for Master URL in live environments unless explicitly opted in via `SLATE_ALLOW_LOCALHOST_MASTER=1`.
4. **Never Expose Raw Keys:** Never display raw license keys on public endpoints or unauthenticated responses; always use masked keys (`last4`).
5. **Zero Data Deletion on Expiry:** Expiration, revocation, or suspension must lock plugin execution without touching or dropping tenant databases or files.
