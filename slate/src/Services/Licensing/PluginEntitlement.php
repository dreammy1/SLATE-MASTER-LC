<?php
/**
 * Slate - PluginEntitlement: the ONE place that decides whether a plugin may run.
 *
 * Why central instead of a guard file inside each plugin folder: a per-plugin
 * copy means eight copies of the same decision. The first time the rule changes
 * - a new status, a grace period, a trial - someone updates seven of them. So
 * the decision lives here and plugins opt in with one line in plugin.json
 * ("licensable": true). PluginLoader consults this before booting a plugin.
 *
 * ENTITLEMENT IS NOT ACTIVATION. Two separate facts decide if a plugin runs:
 *   1. INSTALLED/ACTIVE - the admin turned the plugin on (PluginLoader's own
 *      `plugins` table). Handled by PluginLoader, not here.
 *   2. ENTITLED - the tenant paid for it, or it arrived inside the package
 *      they bought. That is this class.
 * A plugin can be entitled but switched off, or switched on but not entitled.
 * Only "both" means it runs.
 *
 * Resolution order for one plugin slug:
 *   a. Not licensable (no "licensable" in plugin.json)  -> entitled, always.
 *      Core and system plugins must never be gated.
 *   b. Explicit plugin_licenses row for this tenant     -> that row decides.
 *   c. Arrived via the tenant's package pluginSet       -> entitled, but marked
 *      "from package" so the UI offers package renewal, not plugin renewal.
 *   d. Anything else                                    -> not entitled.
 *
 * Layer: Services / Licensing.
 */
declare(strict_types=1);
namespace Slate\Services\Licensing;

class PluginEntitlement
{
    /** A plugin in this state runs normally. */
    private const PASS = ['active', 'trial'];

    /** Still runs, but the UI should nag. */
    private const WARN = ['expired'];

    /** Does not run at all. */
    private const BLOCK = ['suspended', 'revoked', 'cancelled'];

    /** @var array<int,array<string,mixed>> Cached per tenant */
    private static array $map = [];

    /**
     * Everything the tenant is entitled to, in one pass.
     *
     * @return array<string,array{entitled:bool,state:string,source:string,status:string|null,expires_at:string|null,last4:string|null,license_id:int|null,package_slug:string|null}>
     */
    public static function map(?int $tenantId = null): array
    {
        $tenantId = $tenantId ?? (function_exists('current_tenant_id') ? current_tenant_id() : 1);
        if (isset(self::$map[$tenantId])) {
            return self::$map[$tenantId];
        }
        $map = [];

        // (c) Package-derived entitlements. A package license carries the
        // plugin list in the tenant license's metadata, which is where the
        // Master side writes it at issue time.
        $pkg = self::packageEntitlements($tenantId);

        // (b) Explicit plugin licenses override the package view.
        foreach (self::pluginLicenseRows($tenantId) as $row) {
            $slug = (string) ($row['plugin_slug'] ?? '');
            if ($slug === '') {
                continue;
            }
            $status = strtolower((string) ($row['status'] ?? 'none'));
            $expires = $row['expires_at'] ?? null;
            $entitled = self::isEntitled($status, $expires);
            $map[$slug] = [
                'entitled'     => $entitled,
                'state'        => self::stateFor($status, $expires),
                'source'       => (string) ($row['source'] ?? 'single'),
                'status'       => $status,
                'expires_at'   => $expires,
                'last4'        => $row['license_key_last4'] ?? null,
                'license_id'   => isset($row['id']) ? (int) $row['id'] : null,
                'package_slug' => $row['source_package_slug'] ?? null,
            ];
        }

        // Package rows fill in whatever an explicit license did not claim,
        // or provide entitlement if an explicit license is expired/cancelled but package is active.
        foreach ($pkg as $slug => $info) {
            if (!isset($map[$slug])) {
                $map[$slug] = $info;
            } elseif (!$map[$slug]['entitled'] && !empty($info['entitled'])) {
                // Active package entitlement takes precedence over older expired/cancelled single license
                $map[$slug] = $info;
            }
        }

        self::$map[$tenantId] = $map;
        return $map;
    }

    /** Drop the per-request cache (after a purchase lands). */
    public static function forget(?int $tenantId = null): void
    {
        if ($tenantId !== null) {
            unset(self::$map[$tenantId]);
        } else {
            self::$map = [];
        }
    }

    /**
     * The single question callers should ask.
     *
     * $licensable comes from plugin.json. When false the plugin is core/system
     * and is never gated - returning true here is what keeps media-library and
     * mcp-gateway working.
     */
    public static function allows(string $slug, bool $licensable, ?int $tenantId = null, bool $allowExpired = false): bool
    {
        if (!$licensable) {
            return true;
        }
        $info = self::map($tenantId)[$slug] ?? null;
        if ($info === null) {
            return false; // licensable, nothing on record -> must be bought
        }
        if ($allowExpired && ($info['state'] ?? '') === 'expired') {
            return true;
        }
        return (bool) $info['entitled'];
    }

    /** Full detail for one slug (used by the shop and My Licenses screens). */
    public static function info(string $slug, ?int $tenantId = null): array
    {
        return self::map($tenantId)[$slug] ?? [
            'entitled'     => false,
            'state'        => 'unowned',
            'source'       => 'none',
            'status'       => null,
            'expires_at'   => null,
            'last4'        => null,
            'license_id'   => null,
            'package_slug' => null,
        ];
    }

    /**
     * May the customer renew this plugin directly?
     *
     * No when it came from a package: renewing the plugin alone would leave the
     * package in a confusing half-renewed state, and the customer would end up
     * paying for something the package already covers on its own schedule.
     */
    public static function canRenewIndividually(string $slug, ?int $tenantId = null): bool
    {
        $info = self::info($slug, $tenantId);
        return $info['source'] !== 'package' && $info['license_id'] !== null;
    }

    /**
     * Status + expiry -> does it run?
     *
     * An "active" row whose expires_at has passed is EXPIRED, not active. The
     * database is not swept on a schedule, so a lapsed license would otherwise
     * keep working until someone happened to run the sweeper.
     */
    private static function isEntitled(string $status, ?string $expiresAt): bool
    {
        if (in_array($status, self::BLOCK, true)) {
            return false;
        }
        if ($status === 'expired') {
            return false;
        }
        if (!in_array($status, self::PASS, true)) {
            return false;
        }
        if ($expiresAt !== null && $expiresAt !== '' && strtotime($expiresAt) !== false) {
            if (strtotime($expiresAt) <= time()) {
                return false;
            }
        }
        return true;
    }

    /** Coarse state string for badges: active | expiring | expired | blocked | unowned. */
    private static function stateFor(string $status, ?string $expiresAt): string
    {
        if (in_array($status, self::BLOCK, true)) {
            return 'blocked';
        }
        if ($status === 'expired') {
            return 'expired';
        }
        if (!in_array($status, self::PASS, true)) {
            return 'unowned';
        }
        if ($expiresAt !== null && $expiresAt !== '' && strtotime($expiresAt) !== false) {
            $left = strtotime($expiresAt) - time();
            if ($left <= 0) {
                return 'expired';
            }
            if ($left <= 7 * 86400) {
                return 'expiring';
            }
        }
        return 'active';
    }

    /** @return array<int,array<string,mixed>> */
    private static function pluginLicenseRows(int $tenantId): array
    {
        try {
            return \Database::rows(
                "SELECT id, plugin_slug, status, expires_at, source, source_package_slug,
                        license_key_last4, billing_cycle
                   FROM plugin_licenses
                  WHERE tenant_id = ?
               ORDER BY FIELD(status,'active','trial','expired','suspended','revoked','cancelled'), id DESC",
                [$tenantId]
            );
        } catch (\Throwable $e) {
            return []; // pre-migration
        }
    }

    /**
     * Plugins the tenant's package includes.
     *
     * Read from the license metadata the Master side writes at issue time
     * ("pluginSet"), with a fallback to the plan's own feature list so a tenant
     * licensed before this feature existed is not suddenly locked out of the
     * plugins they already had running.
     *
     * @return array<string,array<string,mixed>>
     */
    private static function packageEntitlements(int $tenantId): array
    {
        $out = [];
        try {
            $row = \Database::row(
                "SELECT id, status, expires_at, metadata, package_slug
                   FROM licenses
                  WHERE tenant_id = ?
               ORDER BY created_at DESC, id DESC LIMIT 1",
                [$tenantId]
            );
            if (!$row) {
                return $out;
            }
            $status = strtolower((string) ($row['status'] ?? 'none'));
            $expires = $row['expires_at'] ?? null;
            $entitled = self::isEntitled($status, $expires);
            $state = self::stateFor($status, $expires);
            $pkgSlug = $row['package_slug'] ?? null;

            $meta = json_decode((string) ($row['metadata'] ?? ''), true);
            $slugs = [];
            if (is_array($meta)) {
                foreach (['pluginSet', 'plugin_set', 'plugins'] as $key) {
                    if (!empty($meta[$key]) && is_array($meta[$key])) {
                        $slugs = $meta[$key];
                        break;
                    }
                }
            }
            // Fallback: the tenant had a package license before pluginLists
            // were recorded, so treat every licensable plugin on disk as
            // included rather than revoking working software retroactively.
            if (!$slugs) {
                $slugs = self::licensableSlugsFromDisk();
            }
            foreach ($slugs as $slug) {
                $slug = strtolower(trim((string) $slug));
                if ($slug === '') {
                    continue;
                }
                $out[$slug] = [
                    'entitled'     => $entitled,
                    'state'        => $state,
                    'source'       => 'package',
                    'status'       => $status,
                    'expires_at'   => $expires,
                    'last4'        => null,
                    'license_id'   => null,
                    'package_slug' => $pkgSlug,
                ];
            }
        } catch (\Throwable $e) {
            return $out;
        }
        return $out;
    }

    /** @return array<int,string> */
    private static function licensableSlugsFromDisk(): array
    {
        $slugs = [];
        try {
            $dir = defined('SLATE_ROOT') ? SLATE_ROOT . '/plugins' : __DIR__ . '/../../../plugins';
            foreach ((array) glob(rtrim($dir, '/') . '/*/plugin.json') as $file) {
                $m = json_decode((string) @file_get_contents($file), true);
                if (is_array($m) && !empty($m['licensable']) && !empty($m['slug'])) {
                    $slugs[] = (string) $m['slug'];
                }
            }
        } catch (\Throwable $e) {
            // no-op
        }
        return $slugs;
    }
}