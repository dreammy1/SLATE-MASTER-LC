<?php
/**
 * shop_client.php — helpers for the Plugin Shop and My Licenses pages.
 *
 * Included by admin/my-licenses.php and admin/plugins-shop.php.
 * Provides functions to communicate with the Master Dashboard for
 * checkout, profile auto-fill, and entitlement queries.
 *
 * No direct Stripe calls here — all payment goes through Master.
 */
declare(strict_types=1);

use Slate\Services\Licensing\TenantToken;
use Slate\Services\Licensing\PluginEntitlement;
use Slate\Services\Licensing\LicenseCatalog;

/** Build the configured public Master Dashboard base URL. */
function shop_master_url(): string
{
    $url = '';
    if (function_exists('env')) {
        $url = (string) (env('SLATE_MASTER_URL', '') ?: env('LICENSE_MASTER_URL', ''));
    }
    if ($url === '') {
        $url = (string) (getenv('SLATE_MASTER_URL') ?: getenv('LICENSE_MASTER_URL') ?: '');
    }
    if ($url === '') {
        $configPath = defined('SLATE_ROOT') ? SLATE_ROOT . '/.slate_agent_config.json' : __DIR__ . '/../.slate_agent_config.json';
        if (is_file($configPath)) {
            $config = json_decode((string) @file_get_contents($configPath), true);
            if (is_array($config)) $url = (string) ($config['master_host'] ?? $config['master_url'] ?? '');
        }
    }
    if ($url === '') return '';
    if (!preg_match('#^https?://#i', $url)) $url = 'https://' . $url;
    $parts = parse_url($url);
    if (!is_array($parts) || empty($parts['host']) || !in_array(strtolower((string)($parts['scheme'] ?? '')), ['http', 'https'], true)) return '';
    if (in_array(strtolower((string)$parts['host']), ['localhost', '127.0.0.1', '::1', '0.0.0.0'], true) && getenv('SLATE_ALLOW_LOCALHOST_MASTER') !== '1') return '';
    $origin = strtolower((string)$parts['scheme']) . '://' . $parts['host'];
    if (!empty($parts['port'])) $origin .= ':' . (int)$parts['port'];
    return rtrim($origin, '/');
}

/** Return true only for a local, explicitly licensable plugin manifest. */
function shop_is_valid_plugin_slug(string $slug): bool
{
    if ($slug === '' || !preg_match('/^[a-z0-9][a-z0-9-]*$/', $slug)) return false;
    $manifestPath = (defined('SLATE_ROOT') ? SLATE_ROOT : dirname(__DIR__)) . '/plugins/' . $slug . '/plugin.json';
    if (!is_file($manifestPath)) return false;
    $manifest = json_decode((string) @file_get_contents($manifestPath), true);
    return is_array($manifest) && ($manifest['slug'] ?? '') === $slug && !empty($manifest['licensable']) && empty($manifest['system']);
}

/** Mint a short-lived checkout token for the current admin user. */
function shop_checkout_token(): ?string
{
    $tenantId = function_exists('current_tenant_id') ? (int) current_tenant_id() : 1;
    $domain = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $email = '';
    if (class_exists('Auth') && method_exists('Auth', 'user')) {
        $user = Auth::user();
        $email = $user['email'] ?? '';
    }
    return TenantToken::mint($tenantId, $domain, $email);
}

/** Get the checkout iframe URL for a single plugin purchase or renewal. */
function shop_checkout_url(string $pluginSlug, string $cycle = 'monthly', ?string $licenseId = null): string
{
    if (!shop_is_valid_plugin_slug($pluginSlug)) return '#invalid-product';
    $masterUrl = shop_master_url();
    if ($masterUrl === '') return '#master-unavailable';
    $token = shop_checkout_token();
    if (!$token) return '#token-error';
    $qs = http_build_query([
        'token' => $token,
        'type' => $licenseId ? 'plugin_renewal' : 'single',
        'items' => $pluginSlug,
        'plugin_slug' => $pluginSlug,
        'license_id' => $licenseId ?: null,
        'cycle' => $cycle,
    ]);
    return $masterUrl . '/checkout?' . $qs;
}

/** Get the checkout iframe URL for a package purchase or renewal. */
function shop_package_checkout_url(string $packageSlug, string $cycle = 'yearly', ?string $licenseId = null): string
{
    if ($packageSlug === '' || !preg_match('/^[a-z0-9][a-z0-9-]*$/', $packageSlug)) return '#invalid-product';
    $masterUrl = shop_master_url();
    if ($masterUrl === '') return '#master-unavailable';
    $token = shop_checkout_token();
    if (!$token) return '#token-error';
    $qs = http_build_query([
        'token' => $token,
        'type' => $licenseId ? 'package_renewal' : 'package',
        'items' => $packageSlug,
        'package_slug' => $packageSlug,
        'license_id' => $licenseId ?: null,
        'cycle' => $cycle,
    ]);
    return $masterUrl . '/checkout?' . $qs;
}

/** Quick helper: is a given plugin slug entitled for this tenant? */
function shop_is_entitled(string $slug): bool
{
    try { return PluginEntitlement::allows($slug, true); } catch (\Throwable $e) { return false; }
}

/** Return entitlement info array for one plugin. */
function shop_entitlement_info(string $slug): array
{
    try { return PluginEntitlement::info($slug); } catch (\Throwable $e) {
        return ['entitled' => false, 'state' => 'error', 'source' => 'none', 'status' => null, 'expires_at' => null, 'last4' => null, 'license_id' => null, 'package_slug' => null];
    }
}

/** Tenant-scoped read model used by My Licenses and Plugins Shop. */
function shop_license_catalog(): array
{
    try { return LicenseCatalog::forCurrentTenant(); } catch (\Throwable $e) { return ['core' => null, 'plugins' => [], 'items' => []]; }
}

/** Return a normalized status for a license row without writing to storage. */
function shop_license_status(?string $status, ?string $expiresAt = null): string
{
    return LicenseCatalog::status($status, $expiresAt);
}
