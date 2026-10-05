# Slate Licensing — Remaining Work To-Do

## Current release: Phases 0–2

- [x] Verify licensing and checkout contracts.
- [x] Add tenant-scoped `LicenseCatalog` service.
- [x] Add normalized status and renewal rules.
- [x] Add My Licenses UI.
- [x] Add Plugins Shop UI.
- [x] Add search, category filter, sorting, and billing-cycle selector.
- [x] Add license/package status labels and checkout iframe launch points.
- [x] Add PHP and inline JavaScript validation.

## Phase 3 — Checkout profile and renewal contract

- [ ] Confirm Master checkout session route accepts all purchase contexts.
- [ ] Confirm package renewal and plugin renewal payload shapes.
- [ ] Complete editable returning-customer profile fields.
- [ ] Add profile validation and tenant isolation tests.
- [ ] Ensure profile writes never accept payment-card fields.
- [ ] Add Stripe metadata for renewal license/order identifiers.
- [ ] Add checkout success/cancel response contract.
- [ ] Test expired and invalid tenant tokens.

## Phase 4 — Client checkout bridge

- [x] Fix `slate/admin/checkout-modal.php` bootstrap include.
- [x] Remove the hardcoded localhost Master URL.
- [x] Reuse safe Master URL resolution in every checkout entry point.
- [x] Validate product slugs against the local catalog.
- [x] Add iframe origin validation and safe `postMessage` handling.
- [x] Add missing-token and unavailable-Master error states.
- [x] Refresh license UI after successful checkout.
- [ ] Verify purchase, package renewal, and plugin renewal links.

## Phase 5 — Fulfillment and synchronization

- [ ] Verify Stripe webhook idempotency.
- [ ] Verify standalone plugin license creation.
- [ ] Verify package-included entitlement creation.
- [ ] Verify renewal extends the correct expiry date.
- [ ] Verify refund/cancellation/revocation propagation.
- [ ] Verify local entitlement cache refresh.
- [ ] Verify installed plugins unlock without reinstall.
- [ ] Display deployment-required state when plugin files are absent.

## Phase 6 — Enforcement

- [ ] Audit every licensable plugin manifest.
- [ ] Audit protected admin routes and operations.
- [ ] Confirm all routes use central `PluginEntitlement`/license guard logic.
- [ ] Confirm system plugins remain ungated.
- [ ] Test active, trial, expiring, expired, suspended, revoked, and cancelled states.
- [ ] Add restricted-mode links back to My Licenses.
- [ ] Add regression coverage for package versus standalone source.

## Phase 7 — Release and rollout

- [ ] Run `php -l` on all changed PHP files.
- [ ] Run inline JavaScript syntax checks.
- [ ] Run TypeScript typecheck and production build.
- [ ] Run focused unit tests.
- [ ] Run isolated integration/migration tests.
- [ ] Confirm migrations `0023–0025` on the test client.
- [ ] Confirm client Master URL is the Render URL.
- [ ] Push approved commit to GitHub `main`.
- [ ] Confirm Render build completes.
- [ ] Check `https://slate-master-dashboard.onrender.com/api/health`.
- [ ] Verify Master login page and public checkout route.
- [ ] Run client smoke test for both admin pages.
- [ ] Run end-to-end test purchase/renewal in test mode.
- [ ] Record deployed commit and rollback commit.
- [ ] Roll out updated client files only after staging passes.

## Release notes to record

- Deployment commit:
- Render deployment ID:
- Render deployment time:
- Client staging URL:
- Client staging commit/version:
- Test order ID:
- Rollback commit:
- Known limitations:
