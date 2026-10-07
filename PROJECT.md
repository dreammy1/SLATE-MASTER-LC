# Project: SLATE Zero-Touch Deploy & Database Automation Fix

## Architecture
- **Master OS**: Next.js 14 app (`app/api/orders/[id]/deploy/route.ts`, `lib/migrationExecutor.ts`, `lib/releaseResolver.ts`) coordinating deployments over HTTP/SSE.
- **Client Agent**: `auth.php` (`public/auth.php` and `slate/auth.php`) acting as remote agent on target web hosting (e.g. cPanel / LiteSpeed).
- **Target Application**: SLATE PHP Core and `slate-installer.php` running on the customer server.
- **Data Flow**:
  1. `CONNECT`: Master checks `auth.php` connectivity and diagnostics.
  2. `DATABASE`: Master calls `targetProvisionDatabase()`, which probes existing credentials via `database_probe` or invokes `database_create` on `auth.php`. `auth.php` creates or repairs dedicated database/user via cPanel UAPI or verifies connection before returning.
  3. `DEPLOY`: Master filters and packages Slate core ZIP (`resolveReleaseZip`) and uploads archive to `auth.php` (`targetDeployFiles`).
  4. `CONFIG`: Master writes environment configuration (`.env`).
  5. `INSTALL`: Master triggers `slate-installer.php` to run migrations, create admin account, and activate plugins.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Archive Size & Upload Stoppage Fix (50% Halt) | Exclude non-runtime docs/tests in `releaseResolver.ts` to keep ZIP < 2MB; add cPanel fallback and upload error handling in `targetDeployFiles` and `auth.php` | M1 | Survey (explorer_survey_3) |
| 2 | Verified Database Reuse & Discovery Hardening | Prevent parent WordPress `wp-config.php` adoption in `auth.php`; eliminate false `PROVISIONED` return; assert connection probe before reporting ready in `migrationExecutor.ts` | M1 | Survey (explorer_survey_1) |
| 3 | Automatic Database Repair & UAPI Credential Wiring | In-place repair via cPanel UAPI (`create_user`/`set_privileges`) when database exists but user denied; wire `cpanel_host` to `auth.php` | M1 | Survey (explorer_survey_1) |
| 4 | Admin & Self-Service Database Reset / Delete Options | Add `reset_database` action to `/api/clients/[id]/actions` and `clearDatabase` to order/client PATCH APIs; add UI buttons in admin drawer (`/licenses`) and order page (`/orders/[id]`) | M1 | Survey (explorer_survey_2) |
| 5 | Live Deployment & 100% Install Completion | Trigger deploy for `ord_muom5mrzocczf0` on live Render master; verify 100% COMPLETE, license key, `db_ok: true`, admin login 200, retry safety, git commit & push | M2 | Survey (All / Request) |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | M1: Core Implementation (Packaging, DB Probe/Repair & Admin Reset) | `lib/releaseResolver.ts`, `lib/migrationExecutor.ts`, `public/auth.php`, `slate/auth.php`, `app/api/orders/[id]/deploy/route.ts`, `app/api/clients/[id]/actions/route.ts`, `app/api/clients/[id]/route.ts`, `app/api/orders/[id]/route.ts`, `app/licenses/page.tsx`, `app/orders/[id]/page.tsx` | none | IN_PROGRESS |
| 2 | M2: Live Deployment Verification & Push to Main | Live E2E deploy of `ord_muom5mrzocczf0` on Render master, status 100% COMPLETE, HTTP 200 admin login, safe retry, git commit & push | M1 | PLANNED |

## Interface Contracts
### Master OS ↔ Remote Agent (`auth.php`)
- `POST /auth.php?action=database_create`:
  - Request: `{ cpanel_user, cpanel_token, cpanel_host, requested_name }`
  - Response on success: `{ status: "PROVISIONED" | "REUSED", credentials: { db_name, db_user, db_password, db_host }, verified: true }`
  - Response on failure: `{ status: "FAILED", error: string }` (NEVER return PROVISIONED on connection failure)
- `POST /auth.php?action=database_reset`:
  - Request: `{}`
  - Response: `{ success: true, message: "Cleared provisioned database cache" }`
- `POST /auth.php?action=database_probe`:
  - Request: `{ db_name, db_user, db_password, db_host }`
  - Response: `{ status: "CONNECTED" | "FAILED", error?: string }`
- `POST /auth.php?action=deploy`:
  - Request: multipart form with `archive` ZIP file
  - Response on size error: `{ error: "Uploaded archive exceeds server upload_max_filesize (...)" }`

### Admin / Client Action API
- `POST /api/clients/[id]/actions`:
  - Body: `{ action: "reset_database" }`
  - Result: Clears database fields on the order record and invokes remote agent `database_reset`.
- `PATCH /api/orders/[id]`:
  - Body: `{ clearDatabase: true }`
  - Result: Clears `dbName`, `dbUser`, `dbPassEncrypted`, `dbHost` from the order and resets error state.

## Code Layout
- `lib/releaseResolver.ts`: Archive file filtering and zip creation.
- `lib/migrationExecutor.ts`: Deployment execution, database provisioning, file upload.
- `public/auth.php` and `slate/auth.php`: Remote agent scripts (must remain byte-for-byte identical).
- `app/api/orders/[id]/deploy/route.ts`: Deployment orchestration route and SSE stream emitter.
- `app/api/clients/[id]/actions/route.ts`: Admin client action endpoint.
- `app/api/clients/[id]/route.ts` & `app/api/orders/[id]/route.ts`: Order/Client update endpoints.
- `app/licenses/page.tsx`: Admin license & client detail management UI drawer.
- `app/orders/[id]/page.tsx`: Customer-facing and admin order detail & self-edit UI.
