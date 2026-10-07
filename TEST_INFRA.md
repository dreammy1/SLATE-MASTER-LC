# E2E Test Infra: SLATE Deploy & Database Automation

## Test Philosophy
- Opaque-box, requirement-driven derived from ORIGINAL_REQUEST.md.
- Verification channels: Live Master Render API endpoints, Remote Agent diagnostics and status endpoints, and Client Web Application endpoints.

## Feature Inventory
| # | Feature | Source | Tier 1 (Coverage) | Tier 2 (Boundary) | Tier 3 (Cross-Feature) | Tier 4 (Real-World) |
|---|---------|--------|:-----------------:|:-----------------:|:----------------------:|:-------------------:|
| 1 | Archive Size & Upload Stoppage Fix | ORIGINAL_REQUEST §2026-10-04T20:48:19Z | 5 | 5 | ✓ | ✓ |
| 2 | Verified Database Reuse & Discovery | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ | ✓ |
| 3 | Automatic Database Repair | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ | ✓ |
| 4 | Admin Manual DB Reset Controls | ORIGINAL_REQUEST §2026-10-04T20:48:19Z | 5 | 5 | ✓ | ✓ |
| 5 | Live Deploy Completion & Safe Retry | ORIGINAL_REQUEST §R2, §R3, Acceptance | 5 | 5 | ✓ | ✓ |

## Test Architecture
- **Local Test Runner**: `npm run build` for zero-error build verification.
- **File Parity Check**: `git diff --no-index public/auth.php slate/auth.php` for remote agent synchronization.
- **Archive Size Check**: Node script verifying packaged ZIP is < 2.0 MB.
- **Remote Diagnostics Check**: `curl.exe -k -s https://hgg-offenbach.de/slate/auth.php?action=diagnostics`.
- **Live Deploy Stream Verification**: `curl.exe -k -N -s -X POST https://slate-master-dashboard.onrender.com/api/orders/ord_muom5mrzocczf0/deploy -H "Content-Type: application/json" -d "{}"`.
- **Order State Verification**: `curl.exe -k -s https://slate-master-dashboard.onrender.com/api/orders/ord_muom5mrzocczf0`.
- **Target Status Check**: `curl.exe -k -s https://hgg-offenbach.de/slate/slate-installer.php?action=status`.
- **Admin Login Check**: `curl.exe -k -s -I https://hgg-offenbach.de/slate/admin/login.php` (HTTP 200).
- **Retry Safety Check**: Second deploy trigger verification.
