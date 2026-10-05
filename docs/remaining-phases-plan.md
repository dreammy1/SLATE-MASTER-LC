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

### Phase 3 implementation contract

The checkout flow must treat the signed tenant token as the authority for the
customer and installation context. Client-supplied profile fields are editable
data only; they must never be used to select a tenant, license, price, or
Stripe account.

#### Canonical purchase context

Every session request should normalize to the following shape before any Stripe
call is made:

```ts
type PurchaseContext = {
  kind: "standalone_plugin" | "package" | "package_renewal" | "plugin_renewal";
  pluginSlug?: string;
  packageSlug?: string;
  licenseId?: string;
  orderId?: string;
};
```

Required rules:

- `standalone_plugin` requires a catalog-valid `pluginSlug`.
- `package` requires a catalog-valid `packageSlug`.
- `package_renewal` requires the existing package `licenseId` and must verify
  that the license belongs to the signed tenant.
- `plugin_renewal` requires `licenseId` and must verify that the license
  belongs to the signed tenant and matches the requested plugin.
- `orderId`, when present, is an internal correlation value only; it must not
  override the tenant or entitlement selected from the token and database.
- Unknown fields, conflicting identifiers, and mismatched renewal context are
  rejected with a stable `400` response before Stripe is contacted.

#### Profile contract

`GET /api/master/checkout/profile` returns the tenant-scoped profile with these
editable fields: `name`, `email`, `phone`, `company`, `taxId`, `country`,
`city`, `address`, and `postalCode`. `PUT`/`POST` accepts the same allow-list
only and returns the normalized saved profile. Payment-card numbers, CVC,
expiry, bank details, Stripe payment method objects, and arbitrary metadata
must be rejected rather than silently persisted.

The profile route must:

1. verify signature, expiry, audience, issuer, and allowed origin on every
   request;
2. resolve the tenant from the verified token, never from the request body;
3. normalize email/country and trim bounded text fields;
4. apply the same validation rules on read-back and write;
5. return a non-sensitive error envelope such as
   `{ "error": { "code": "invalid_token", "message": "..." } }`.

#### Stripe metadata contract

The checkout session must include only non-secret correlation values needed by
fulfillment and support, for example:

```json
{
  "tenant_id": "tenant_…",
  "purchase_kind": "plugin_renewal",
  "plugin_slug": "example-plugin",
  "license_id": "license_…",
  "order_id": "order_…"
}
```

Metadata is not an authorization mechanism. The webhook must re-validate the
tenant, product, and renewal target against server-side records before changing
entitlements. Do not include raw tenant tokens, license keys, card data, or
profile secrets in Stripe metadata, URLs, logs, or iframe messages.

#### Success and cancellation bridge

The checkout page should expose a small, versioned iframe contract:

- success: `{ "type": "slate.checkout.completed", "version": 1,
  "sessionId": "…" }`
- cancellation: `{ "type": "slate.checkout.cancelled", "version": 1 }`
- failure: `{ "type": "slate.checkout.failed", "version": 1,
  "code": "…" }`

Messages must be sent only to the validated parent origin. The client must
ignore unknown message types, mismatched origins, duplicate completion events,
and messages received after the modal has been closed. A completion message
means that Stripe completed checkout; the client should refresh licenses and
display fulfillment-pending state until the webhook-backed entitlement is
visible.

### Phase 3 execution order

Implement Phase 3 in small, reversible slices:

1. **Contract tests first:** add request/response fixtures for all four
   purchase contexts, profile allow-list behavior, token failures, and Stripe
   metadata.
2. **Token boundary:** centralize verification and tenant resolution for both
   profile and session routes; remove route-local fallbacks.
3. **Profile persistence:** implement load, allow-listed save, normalization,
   and read-back tests using an isolated database.
4. **Context normalization:** validate catalog slugs and renewal ownership
   before creating a checkout session.
5. **Metadata and return URLs:** attach correlation metadata and derive success
   and cancel URLs from the configured production origin, with localhost
   allowed only in explicit local development mode.
6. **Iframe bridge:** implement the versioned success/cancel/failure messages,
   origin checks, duplicate-event protection, and license refresh.
7. **Regression pass:** run the focused test matrix, then the existing Stripe
   race and entitlement integration tests before starting Phase 4.

### Phase 3 verification matrix

| Area | Pass cases | Reject/negative cases |
| --- | --- | --- |
| Token | valid tenant token; correct audience and origin | missing, expired, tampered, wrong audience, wrong origin, cross-tenant token |
| Profile | load; edit; save; normalized read-back | card fields; oversized fields; malformed email/country; tenant mismatch |
| Purchase | standalone plugin; package; package renewal; plugin renewal | unknown slug; missing renewal ID; mismatched plugin/license; conflicting IDs |
| Metadata | stable tenant/product/license/order correlation values | raw token, raw key, payment data, arbitrary unvalidated fields |
| Return URLs | configured HTTPS production origin; explicit local development origin | localhost in production; arbitrary external origin; malformed URL |
| Iframe bridge | one completion refreshes licenses; cancellation closes cleanly | wrong origin; unknown type; duplicate completion; post-close event |

### Phase 3 implementation evidence

Before marking Phase 3 complete, record the following in the release notes:

- commit containing the contract and route changes;
- test command and passing result for the focused Phase 3 suite;
- migration/database version used by the isolated test database;
- configured production origin used for success and cancellation URLs;
- representative checkout session ID for test mode, with no card data stored;
- confirmation that the webhook fulfillment test observes the expected renewal
  identifiers and tenant scope.

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
