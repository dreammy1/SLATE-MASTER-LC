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
            $allow = ['login.php', 'logout.php', 'billing.php', 'activate.php', 'cron.php', 'my-licenses.php'];
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
            // If the request targets a plugin, evaluate the plugin entitlement first
            if (preg_match('#(?:^|/)plugins/([^/]+)/#i', strtolower(str_replace('\\', '/', (string)$script)))) {
                slate_plugin_guard($script, $tenantId);
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

    /**
     * The package slug this site was installed with.
     *
     * Written to .slate_agent_config.json by the Master agent during setup and
     * pushed into .env as SLATE_PACKAGE_SLUG. Without it the guard cannot tell
     * one package's restriction rules from another's.
     */
    function slate_package_slug(): string
    {
        static $slug = null;
        if ($slug !== null) return $slug;
        $slug = '';
        if (function_exists('env')) {
            $slug = (string) env('SLATE_PACKAGE_SLUG', '');
        }
        if ($slug === '' && isset($_ENV['SLATE_PACKAGE_SLUG'])) {
            $slug = (string) $_ENV['SLATE_PACKAGE_SLUG'];
        }
        if ($slug === '') {
            $v = getenv('SLATE_PACKAGE_SLUG');
            if ($v !== false) $slug = (string) $v;
        }
        if ($slug === '') {
            $cfgPath = __DIR__ . '/../.slate_agent_config.json';
            if (is_file($cfgPath)) {
                $cfg = json_decode((string) @file_get_contents($cfgPath), true);
                if (is_array($cfg) && !empty($cfg['package_slug'])) {
                    $slug = (string) $cfg['package_slug'];
                }
            }
        }
        $slug = strtolower(trim($slug, " \t\"'"));
        return $slug;
    }
    /**
     * @return array<int,array{match:string,mode:string}>
     *
     * Rows are scoped to THIS site's package. Previously every package's rules
     * were loaded in one flat list, so a Business Ops site also picked up
     * Coaching Suite's restrictions (and vice versa) - whichever rows happened
     * to sort first won.
     */
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
        $slug = slate_package_slug();
        try {
            if (class_exists('Database') && $slug !== '') {
                $rows = \Database::rows(
                    "SELECT `match`, `mode` FROM package_restrictions WHERE package_slug = ? ORDER BY sort_order ASC, id ASC",
                    [$slug]
                );
                if (!empty($rows)) { $cache = $rows; return $cache; }
            }
        } catch (\Throwable $e) { /* table may not exist pre-migration */ }
        // No slug known, or the package has no rows: fall back to the built-in
        // defaults so an un-migrated site still gets read-only expiry mode.
        $cache = $defaults;
        return $cache;
    }
}

if (!function_exists('slate_plugin_guard')) {
    /**
     * Intercepts protected plugin admin routes and actions using PluginEntitlement::allows().
     *
     * Rules:
     * 1. System / non-licensable plugins (media-library, mcp-gateway, etc.) are ungated.
     * 2. active / trial: Full feature access.
     * 3. expiring: Full feature access with renewal banner.
     * 4. expired: Restricted read-only mode.
     *    - Defines SLATE_READONLY and SLATE_PLUGIN_READONLY.
     *    - POST requests (mutations) are rejected with a redirect / error (zero tenant data loss).
     *    - GET requests are allowed to render without PHP fatal errors.
     *    - Displays a user-friendly restricted mode notice banner linking to /admin/my-licenses.php.
     * 5. suspended / revoked / cancelled / unowned:
     *    - Operations completely blocked with redirect to /admin/my-licenses.php (or JSON 403 on API).
     *    - Zero tenant data loss: tables and settings are preserved.
     *
     * @return array{ok:bool, state:string, mode:string, slug:string|null}
     */
    function slate_plugin_guard(?string $target = null, ?int $tenantId = null): array
    {
        try {
            $slug = null;
            if ($target !== null && !str_contains($target, '/') && !str_contains($target, '\\')) {
                $slug = strtolower(trim($target));
                $scriptPath = (string)($_SERVER['SCRIPT_NAME'] ?? $_SERVER['SCRIPT_FILENAME'] ?? $_SERVER['REQUEST_URI'] ?? '');
                $norm = strtolower(str_replace('\\', '/', $scriptPath));
            } else {
                $scriptPath = $target ?? (string)($_SERVER['SCRIPT_NAME'] ?? '');
                if ($scriptPath === '' && isset($_SERVER['SCRIPT_FILENAME'])) {
                    $scriptPath = (string)$_SERVER['SCRIPT_FILENAME'];
                }
                if ($scriptPath === '' && isset($_SERVER['REQUEST_URI'])) {
                    $scriptPath = (string)parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
                }
                $norm = strtolower(str_replace('\\', '/', $scriptPath));

                // Ignore static assets
                if (preg_match('/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/i', $norm)) {
                    return ['ok' => true, 'state' => 'asset', 'mode' => 'ok', 'slug' => null];
                }

                if (preg_match('#(?:^|/)plugins/([^/]+)/#i', $norm, $m)) {
                    $slug = strtolower(trim($m[1]));
                }
            }

            if (!$slug || $slug === '_dist') {
                return ['ok' => true, 'state' => 'none', 'mode' => 'ok', 'slug' => null];
            }

            $rootDir = defined('SLATE_ROOT') ? SLATE_ROOT : dirname(__DIR__);
            $manifestPath = $rootDir . '/plugins/' . $slug . '/plugin.json';
            if (!is_file($manifestPath)) {
                return ['ok' => true, 'state' => 'none', 'mode' => 'ok', 'slug' => $slug];
            }

            $manifest = json_decode((string)@file_get_contents($manifestPath), true);
            if (!is_array($manifest)) {
                return ['ok' => true, 'state' => 'none', 'mode' => 'ok', 'slug' => $slug];
            }

            $isSystem = !empty($manifest['system']);
            $isLicensable = !empty($manifest['licensable']);

            // Non-licensable or system plugins (e.g. media-library, mcp-gateway) are ungated
            if ($isSystem || !$isLicensable) {
                return ['ok' => true, 'state' => 'system', 'mode' => 'ok', 'slug' => $slug];
            }

            $tenantId ??= (function_exists('current_tenant_id') ? current_tenant_id() : 1);

            $allowed = false;
            $info = [
                'entitled'   => false,
                'state'      => 'unowned',
                'source'     => 'none',
                'status'     => null,
                'expires_at' => null,
            ];

            if (class_exists('\\Slate\\Services\\Licensing\\PluginEntitlement')) {
                $allowed = \Slate\Services\Licensing\PluginEntitlement::allows($slug, $isLicensable, $tenantId);
                $info = \Slate\Services\Licensing\PluginEntitlement::info($slug, $tenantId);
            }

            $state = (string)($info['state'] ?? 'unowned');
            $pluginName = (string)($manifest['name'] ?? ucfirst($slug));

            // State 1: Active, trial, or expiring (allowed)
            if ($allowed) {
                if ($state === 'expiring') {
                    slate_set_plugin_notice($slug, 'expiring', $pluginName, $info['expires_at'] ?? null);
                }
                return ['ok' => true, 'state' => $state, 'mode' => 'ok', 'slug' => $slug];
            }

            // State 2: Expired -> restricted read-only mode (zero data loss, no fatal errors)
            if ($state === 'expired') {
                if (!defined('SLATE_READONLY')) define('SLATE_READONLY', 1);
                if (!defined('SLATE_PLUGIN_READONLY')) define('SLATE_PLUGIN_READONLY', 1);

                slate_set_plugin_notice($slug, 'expired', $pluginName, $info['expires_at'] ?? null);

                $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
                $isMutation = in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true);
                $isApi = str_contains($norm, '/api/') || (isset($_SERVER['HTTP_ACCEPT']) && str_contains($_SERVER['HTTP_ACCEPT'], 'application/json'));

                if ($isMutation) {
                    if (PHP_SAPI === 'cli') {
                        return ['ok' => false, 'state' => 'expired', 'mode' => 'readonly', 'slug' => $slug];
                    }
                    if ($isApi) {
                        http_response_code(403);
                        header('Content-Type: application/json; charset=utf-8');
                        echo json_encode([
                            'error' => "The $pluginName plugin license has expired. Modifications are blocked in restricted read-only mode.",
                            'plugin' => $slug,
                            'readonly' => true,
                            'code' => 'LICENSE_EXPIRED',
                        ]);
                        exit;
                    }
                    $home = defined('SLATE_URL') ? rtrim((string)SLATE_URL, '/') : '';
                    $redirectUrl = $home !== '' ? $home . '/admin/my-licenses.php' : 'my-licenses.php';
                    header('Location: ' . $redirectUrl . '?expired_plugin=' . urlencode($slug) . '&readonly=1', true, 302);
                    exit;
                }

                // GET requests: allow view in read-only mode with banner
                return ['ok' => true, 'state' => 'expired', 'mode' => 'readonly', 'slug' => $slug];
            }

            // State 3: Blocked (suspended, revoked, cancelled) or unowned -> complete block
            if (PHP_SAPI === 'cli') {
                return ['ok' => false, 'state' => $state, 'mode' => 'blocked', 'slug' => $slug];
            }

            $isApi = str_contains($norm, '/api/') || (isset($_SERVER['HTTP_ACCEPT']) && str_contains($_SERVER['HTTP_ACCEPT'], 'application/json'));
            if ($isApi) {
                http_response_code(403);
                header('Content-Type: application/json; charset=utf-8');
                echo json_encode([
                    'error' => "The $pluginName plugin requires an active license ($state). Access blocked.",
                    'plugin' => $slug,
                    'state' => $state,
                    'code' => 'LICENSE_' . strtoupper($state),
                    'renew_url' => (defined('SLATE_URL') ? SLATE_URL : '') . '/admin/my-licenses.php',
                ]);
                exit;
            }

            $home = defined('SLATE_URL') ? rtrim((string)SLATE_URL, '/') : '';
            $redirectUrl = $home !== '' ? $home . '/admin/my-licenses.php' : 'my-licenses.php';
            header('Location: ' . $redirectUrl . '?blocked_plugin=' . urlencode($slug) . '&state=' . urlencode($state), true, 302);
            exit;

        } catch (\Throwable $e) {
            // Never fail open into catastrophic crash on infra error
            return ['ok' => true, 'state' => 'error', 'mode' => 'ok', 'slug' => null];
        }
    }
}

if (!function_exists('slate_require_plugin_entitlement')) {
    function slate_require_plugin_entitlement(string $slug, ?int $tenantId = null): array
    {
        return slate_plugin_guard($slug, $tenantId);
    }
}

if (!function_exists('slate_set_plugin_notice')) {
    function slate_set_plugin_notice(string $slug, string $type, string $name, ?string $expiresAt = null): void
    {
        global $slateActivePluginNotice;
        $dateStr = $expiresAt ? date('M j, Y', strtotime($expiresAt)) : '';
        if ($type === 'expired') {
            $slateActivePluginNotice = [
                'slug'    => $slug,
                'type'    => 'warning',
                'title'   => 'License Expired (' . $name . ')',
                'message' => $name . ' is operating in restricted read-only mode. All data is safely preserved.' . ($dateStr ? " (Expired: $dateStr)" : ''),
                'action'  => 'Renew License',
                'url'     => (defined('SLATE_URL') ? SLATE_URL : '') . '/admin/my-licenses.php',
            ];
        } elseif ($type === 'expiring') {
            $slateActivePluginNotice = [
                'slug'    => $slug,
                'type'    => 'info',
                'title'   => 'License Expiring Soon (' . $name . ')',
                'message' => $name . ' license will expire' . ($dateStr ? " on $dateStr" : ' soon') . '. Renew now to prevent interruption.',
                'action'  => 'Renew License',
                'url'     => (defined('SLATE_URL') ? SLATE_URL : '') . '/admin/my-licenses.php',
            ];
        }
    }
}

if (!function_exists('slate_plugin_active_notice')) {
    function slate_plugin_active_notice(): ?array
    {
        global $slateActivePluginNotice;
        return $slateActivePluginNotice ?? null;
    }
}

