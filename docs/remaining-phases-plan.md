# Slate Licensing Plan — Remaining Phases

**Current status:** Phases 0–2 implemented locally.

- Phase 0: licensing and checkout contract verification
- Phase 1: tenant-scoped license catalog and status rules
- Phase 2: My Licenses and Plugins Shop UI
- Current implementation commits: `f8664bb`, `71b4f8f`

## Phase 3 — Master checkout profile and renewal contract

### Objective
Make the embedded checkout flow production-ready for returning customers, package renewals, and standalone plugin renewals.

### Work

- Complete profile load/save behavior through `/api/master/checkout/profile`.
- Support name, email, phone, company, tax/VAT ID, country, city, address, and postal code.
- Validate signed tenant tokens on every profile and checkout request.
- Add explicit purchase context:
  - standalone plugin
  - package purchase
  - package renewal
  - plugin renewal
- Pass license/order identifiers into checkout metadata where required.
- Ensure Stripe checkout uses the configured production URL, never localhost in production.
- Add checkout success/cancel messaging for the client iframe.
- Keep payment-card data out of Slate storage.

### Exit criteria

- Returning-client profile loads into checkout.
- Customer can edit and save profile data.
- Renewal context is preserved through Stripe checkout.
- Invalid, expired, cross-domain, or tampered tokens are rejected.

## Phase 4 — Client checkout bridge hardening

### Objective
Make the client-side checkout modal reliable on live installations.

### Work

- Fix `slate/admin/checkout-modal.php` to use `config.php`.
- Remove its hardcoded `http://localhost:3000` production URL.
- Resolve the Master host from `SLATE_MASTER_URL`, `LICENSE_MASTER_URL`, or `.slate_agent_config.json`.
- Validate product slugs against the local catalog before creating checkout URLs.
- Add safe iframe lifecycle handling and origin-checked `postMessage` handling.
- Show clear errors for missing token, missing Master URL, checkout failure, and cancellation.
- Refresh license data after successful checkout.

### Exit criteria

- Purchase and renewal buttons open the live Master checkout.
- Checkout cannot redirect to arbitrary external origins.
- Closing/reopening a modal does not retain stale checkout state.

## Phase 5 — Payment fulfillment and entitlement synchronization

### Objective
Ensure paid package and standalone plugin orders create the correct client entitlements.

### Work

- Verify Stripe webhook idempotency for package and plugin orders.
- Create/update plugin license rows for standalone purchases.
- Preserve package source on included plugin entitlements.
- Synchronize status, expiry, billing cycle, source, and masked key information.
- Refresh local entitlement caches after fulfillment.
- Handle payment failures, refunds, cancellations, and renewals.
- Confirm a plugin already installed becomes available without a full reinstall.
- Clearly report when a paid plugin still requires deployment/update files.

### Exit criteria

- Successful standalone purchase appears in My Licenses.
- Package renewal extends included entitlements together.
- Duplicate webhook delivery does not create duplicate licenses.
- Revoked/refunded access is reflected on the client.

## Phase 6 — License enforcement and plugin guard coverage

### Objective
Apply the central entitlement policy consistently across sellable plugins.

### Work

- Audit every `licensable: true` plugin entry point.
- Ensure plugin admin routes and protected operations call the central guard.
- Keep system/core plugins ungated.
- Preserve package-included access through `PluginEntitlement`.
- Define behavior for expired, suspended, revoked, and grace-period states.
- Add readable restricted-mode messages and links to My Licenses.
- Avoid duplicating license logic inside individual plugins.

### Exit criteria

- Every sellable plugin has consistent enforcement.
- Restricted states protect sensitive operations without deleting data.
- Package and standalone source rules produce the same result in UI and runtime.

## Phase 7 — Integration, deployment, and client rollout

### Objective
Validate the complete workflow and safely roll it out to client sites.

### Work

- Run PHP lint and TypeScript/build checks.
- Run unit, integration, migration, and API contract tests.
- Test the live Master at `https://slate-master-dashboard.onrender.com`.
- Test against an isolated client staging site.
- Verify migrations `0023–0025` are installed before enabling the new UI.
- Verify client `SLATE_MASTER_URL`/agent configuration points to the live Master.
- Push approved changes to `main`.
- Confirm Render auto-deploy completes and `/api/health` is healthy.
- Perform a test purchase/renewal with Stripe test mode where available.
- Deploy client files only after the isolated client test passes.
- Record rollback commit and deployment notes.

### Exit criteria

- Live Master health endpoint is healthy after deployment.
- Both client pages load without 500 errors.
- Purchase, renewal, fulfillment, and enforcement work end to end.
- A rollback point is documented.

## Non-negotiable safety rules

- Never store card numbers or payment credentials in Slate.
- Never use localhost URLs in production client configuration.
- Keep all license reads tenant-scoped.
- Never expose raw license keys after initial issuance.
- Do not delete client data when a license expires or is revoked.
- Use an isolated test database for integration tests; never test writes against live client data.
