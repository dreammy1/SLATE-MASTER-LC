# Debug Session: sql-import-action
Session ID: `sql-import-action`
Status: [OPEN]
Opened: 2026-09-14
## Symptom
```
TG[1] SQL IMPORT FAIL: Unknown action. Valid actions: diagnostics, handshake, cpanel_setup, database_scan, database_create, database_probe, deploy
TG[1] config WARN: Unknown action. Valid actions: diagnostics, handshake, cpanel_setup, database_scan, database_create, database_probe, deploy
```
Step 3 (target import) always fails because:
1. The executor sends some `action=sql_import` (or similar) and `action=write_config`
2. The remote agent responds that only the 7 listed actions are valid → missing sql_import/write_config.

## Hypotheses (falsifiable)
H1. Master agent template (`public/auth.php`) is missing the `sql_import` and `write_config` cases in its action switch/dispatcher (so the served download is wrong). → verify by grepping the php master.
H2. The migration executor sends wrong action names (e.g. `sql_import` vs `database_import`, `write_config` vs `config_write` or `deploy_config`). → verify by reading `targetImportDatabase` and `targetWriteConfig` functions in `migrationExecutor.ts`.
H3. The deployed remote auth.php is an older/partial version (stripped) on the user's server; master copy is fine. → unlikely because the user's error message exactly matches a master whitelist response.
H4. Auth.php action string is case-sensitive; executor uses `SQL_IMPORT` vs `sql_import`.
H5. Auth.php requires handshake token with higher privileges for "dangerous" actions (sql_import / write_config) so they are disabled dynamically.

## Plan
- Read master public/auth.php and grep all `case` / action strings inside it → confirm supported set
- Read migrationExecutor targetImportDatabase, targetWriteConfig → confirm action param being sent
- Confirm mismatch, fix side that is wrong (prefer fixing master auth.php if executor names are the canonical ones, per design)
- Get diagnostics clean, produce summary
