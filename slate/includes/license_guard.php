<?php
/**
 * Slate — license guard (read-only expiry mode + per-package URL restrictions).
 * Loaded once from config.php AFTER PluginLoader::boot().
 * - active/trial/none → pass
 * - expired → block matches 302 billing.php; readonly matches define SLATE_READONLY + reject POST
 * - suspended/revoked/cancelled → 302 billing.php?locked=1 (except allowlist)
 * Allowlist (always reachable): login.php, logout.php, billing.php, activate.php
 */
if (!function_exists('slate_license_guard')) {
    function slate_license_guard(?string $script = null): void
    {
        try {
            $script ??= (string)($_SERVER['SCRIPT_NAME'] ?? '');
            $base = basename($script);
            $allow = ['login.php', 'logout.php', 'billing.php', 'activate.php', 'cron.php'];
            if (in_array($base, $allow, true)) return;
            if (PHP_SAPI === 'cli') return;
            if (!class_exists('Database')) return;

            // ── Master-pushed REMOTE ACCESS MODE ──────────────────────────
            // The Master client console can put a site into read-only support
            // mode (SLATE_ACCESS_MODE=readonly pushed through the agent). It must
            // apply even while the license itself is perfectly active, so this is
            // checked BEFORE license validation.
            if (slate_access_mode() === 'readonly') {
                if (!defined('SLATE_READONLY')) define('SLATE_READONLY', 1);
                if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
                    $home = defined('SLATE_URL') ? rtrim((string)SLATE_URL, '/') : '';
                    header('Location: ' . ($home !== '' ? $home . '/admin/index.php' : 'index.php') . '?readonly=1&from=' . urlencode((string)$script), true, 302);
                    exit;
                }
                return;
            }

            $tenantId = function_exists('current_tenant_id') ? current_tenant_id() : 1;
            $res = ['mode' => 'ok', 'status' => 'none'];
            if (class_exists('Slate\Services\Licensing\LicenseClient')) {
                $res = \Slate\Services\Licensing\LicenseClient::validate($tenantId);
            } elseif (class_exists('Slate\Services\Licensing\LicenseService')) {
                $res = ['mode' => 'ok', 'status' => \Slate\Services\Licensing\LicenseService::effectiveStatus($tenantId)];
                if ($res['status'] === 'expired') $res['mode'] = 'expired';
                if (in_array($res['status'], ['suspended', 'revoked', 'cancelled'], true)) $res['mode'] = 'locked';
            }
            if ($res['mode'] === 'ok' || $res['mode'] === 'grace') {
                if ($res['mode'] === 'grace' && !defined('SLATE_LICENSE_GRACE')) define('SLATE_LICENSE_GRACE', 1);
                return;
            }

            $home = defined('SLATE_URL') ? rtrim((string)SLATE_URL, '/') : '';
            $billing = $home !== '' ? $home . '/admin/billing.php' : 'billing.php';

            if ($res['mode'] === 'locked') {
                header('Location: ' . $billing . '?locked=1&from=' . urlencode($script), true, 302);
                exit;
            }

            // expired → check restriction map
            $rules = slate_license_rules();
            $norm = strtolower(str_replace('\\', '/', $script));
            $matched = null;
            foreach ($rules as $r) {
                $m = strtolower(trim((string)($r['match'] ?? '')));
                if ($m === '') continue;
                $hit = false;
                if (str_ends_with($m, '*')) { $hit = str_contains($norm, rtrim($m, '*')); }
                else { $hit = str_ends_with($norm, $m); }
                if ($hit) { $matched = $r; break; }
            }
            if ($matched && ($matched['mode'] ?? 'block') === 'block') {
                header('Location: ' . $billing . '?restricted=' . urlencode($script), true, 302);
                exit;
            }
            if (!defined('SLATE_READONLY')) define('SLATE_READONLY', 1);
            if ($_SERVER['REQUEST_METHOD'] === 'POST' && !csrf_verify_soft()) {
                header('Location: ' . $billing . '?restricted=' . urlencode($script) . '&readonly=1', true, 302);
                exit;
            }
            if ($_SERVER['REQUEST_METHOD'] === 'POST') {
                // Readonly POST: reject with redirect (no mutation)
                header('Location: ' . $billing . '?restricted=' . urlencode($script) . '&readonly=1', true, 302);
                exit;
            }
        } catch (\Throwable $e) {
            return; // never block on infra failure
        }
    }

    function csrf_verify_soft(): bool
    {
        try {
            if (function_exists('csrf_verify')) return csrf_verify();
        } catch (\Throwable $e) { /* fallthrough */ }
        return false;
    }

    /** Master-pushed remote access mode: "full" (default) or "readonly". */
    function slate_access_mode(): string
    {
        static $mode = null;
        if ($mode !== null) return $mode;

        $raw = '';
        if (function_exists('env')) {
            $raw = (string) env('SLATE_ACCESS_MODE', '');
        } elseif (isset($_ENV['SLATE_ACCESS_MODE'])) {
            $raw = (string) $_ENV['SLATE_ACCESS_MODE'];
        } else {
            $v = getenv('SLATE_ACCESS_MODE');
            if ($v !== false) $raw = (string) $v;
        }

        $raw = strtolower(trim($raw, " \t\"'"));
        $mode = in_array($raw, ['full', 'readonly'], true) ? $raw : 'full';
        return $mode;
    }

    /** @return array<int,array{match:string,mode:string}> */
    function slate_license_rules(): array
    {
        static $cache = null;
        if ($cache !== null) return $cache;
        $defaults = [
            ['match' => 'admin/settings.php', 'mode' => 'block'],
            ['match' => 'admin/plugins.php', 'mode' => 'block'],
            ['match' => 'admin/users.php', 'mode' => 'block'],
            ['match' => 'admin/roles.php', 'mode' => 'block'],
            ['match' => 'plugins/booking/admin/new.php', 'mode' => 'block'],
            ['match' => 'plugins/booking/admin/settings.php', 'mode' => 'block'],
            ['match' => 'plugins/stripe-payment/admin/*', 'mode' => 'block'],
            ['match' => 'plugins/booking/admin/appointments.php', 'mode' => 'readonly'],
            ['match' => 'plugins/booking/admin/customers.php', 'mode' => 'readonly'],
            ['match' => 'plugins/membership/admin/members.php', 'mode' => 'readonly'],
            ['match' => 'admin/contact_forms.php', 'mode' => 'readonly'],
        ];
        try {
            if (class_exists('Database')) {
                $rows = \Database::rows("SELECT `match`, `mode` FROM package_restrictions ORDER BY sort_order ASC, id ASC");
                if (!empty($rows)) { $cache = $rows; return $cache; }
            }
        } catch (\Throwable $e) { /* table may not exist pre-migration */ }
        $cache = $defaults;
        return $cache;
    }
}
