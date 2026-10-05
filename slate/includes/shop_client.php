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

/**
 * Build the Master Dashboard base URL.
 *
 * Reads from SLATE_MASTER_URL env, falls back to localhost for dev.
 */
function shop_master_url(): string
{
    $url = '';
    if (function_exists('env')) {
        $url = (string) env('SLATE_MASTER_URL', '');
    }
    if ($url === '') {
        $url = getenv('SLATE_MASTER_URL') ?: 'http://localhost:3000';
    }
    return rtrim($url, '/');
}

/**
 * Mint a short-lived checkout token for the current admin user.
 *
 * Returns null when APP_SECRET is not set (token cannot be signed).
 */
function shop_checkout_token(): ?string
{
    $tenantId = function_exists('current_tenant_id') ? (int) current_tenant_id() : 1;
    $domain   = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $email    = '';
    if (class_exists('Auth') && method_exists('Auth', 'user')) {
        $user  = Auth::user();
        $email = $user['email'] ?? '';
    }
    return TenantToken::mint($tenantId, $domain, $email);
}

/**
 * Get the checkout iframe URL for a single plugin purchase.
 */
function shop_checkout_url(string $pluginSlug, string $cycle = 'monthly'): string
{
    $token = shop_checkout_token();
    if (!$token) {
        return '#token-error';
    }
    $qs = http_build_query([
        'token' => $token,
        'type'  => 'single',
        'items' => $pluginSlug,
        'cycle' => $cycle,
    ]);
    return shop_master_url() . '/checkout?' . $qs;
}

/**
 * Get the checkout iframe URL for a package renewal.
 */
function shop_package_checkout_url(string $packageSlug, string $cycle = 'yearly'): string
{
    $token = shop_checkout_token();
    if (!$token) {
        return '#token-error';
    }
    $qs = http_build_query([
        'token' => $token,
        'type'  => 'package',
        'items' => $packageSlug,
        'cycle' => $cycle,
    ]);
    return shop_master_url() . '/checkout?' . $qs;
}

/**
 * Quick helper: is a given plugin slug entitled for this tenant?
 */
function shop_is_entitled(string $slug): bool
{
    try {
        return PluginEntitlement::allows($slug, true);
    } catch (\Throwable $e) {
        return false;
    }
}

/**
 * Return entitlement info array for one plugin.
 */
function shop_entitlement_info(string $slug): array
{
    try {
        return PluginEntitlement::info($slug);
    } catch (\Throwable $e) {
        return [
            'entitled'     => false,
            'state'        => 'error',
            'source'       => 'none',
            'status'       => null,
            'expires_at'   => null,
            'last4'        => null,
            'license_id'   => null,
            'package_slug' => null,
        ];
    }
}

/**
 * Tenant-scoped read model used by My Licenses and Plugins Shop.
 *
 * Keep page templates on this helper so the UI cannot accidentally query
 * another tenant or duplicate the package-vs-single license rules.
 */
function shop_license_catalog(): array
{
    try {
        return LicenseCatalog::forCurrentTenant();
    } catch (\Throwable $e) {
        return ['core' => null, 'plugins' => [], 'items' => []];
    }
}

/** Return a normalized status for a license row without writing to storage. */
function shop_license_status(?string $status, ?string $expiresAt = null): string
{
    return LicenseCatalog::status($status, $expiresAt);
}
