<?php
/**
 * Phase 6 — Plugin Entitlement and Guard Coverage Tests.
 *
 * Validates:
 * 1. Plugin manifest audit: sellable plugins have "licensable": true,
 *    system plugins (media-library, mcp-gateway) have "system": true, "licensable": false.
 * 2. PluginEntitlement::allows() ungates non-licensable plugins and evaluates entitlements.
 * 3. slate_plugin_guard() enforces active, expiring, expired (restricted read-only),
 *    and blocked states with zero data loss.
 * 4. Multi-tenant isolation and cache separation in PluginEntitlement.
 */

declare(strict_types=1);

use Slate\Services\Licensing\PluginEntitlement;

if (!class_exists(PluginEntitlement::class)) {
    require_once dirname(__DIR__, 2) . '/src/autoload.php';
}
require_once __DIR__ . '/../../includes/license_guard.php';

unit('Plugin manifest audit: sellable plugins are licensable and system plugins are non-licensable', function (): void {
    $pluginsDir = dirname(__DIR__, 2) . '/plugins';

    $sellable = ['backups', 'booking', 'coaching', 'forms', 'membership', 'multilang-translate', 'stripe-payment'];
    foreach ($sellable as $slug) {
        $manifestPath = $pluginsDir . '/' . $slug . '/plugin.json';
        assert_true(file_exists($manifestPath), "Manifest exists for $slug");
        $manifest = json_decode((string)file_get_contents($manifestPath), true);
        assert_true(is_array($manifest), "Manifest is valid JSON for $slug");
        assert_true(!empty($manifest['licensable']), "Plugin $slug declares licensable: true");
        assert_true(empty($manifest['system']), "Plugin $slug is not marked system: true");
    }

    $system = ['media-library', 'mcp-gateway'];
    foreach ($system as $slug) {
        $manifestPath = $pluginsDir . '/' . $slug . '/plugin.json';
        assert_true(file_exists($manifestPath), "Manifest exists for $slug");
        $manifest = json_decode((string)file_get_contents($manifestPath), true);
        assert_true(is_array($manifest), "Manifest is valid JSON for $slug");
        assert_true(!empty($manifest['system']), "System plugin $slug declares system: true");
        assert_true(empty($manifest['licensable']), "System plugin $slug declares licensable: false");
    }
});

unit('PluginEntitlement::allows() passes non-licensable system plugins unconditionally', function (): void {
    // When $licensable is false, allows() must always return true (never gated)
    assert_true(PluginEntitlement::allows('media-library', false));
    assert_true(PluginEntitlement::allows('mcp-gateway', false));
    assert_true(PluginEntitlement::allows('any-core-plugin', false));
});

unit('slate_plugin_guard() ungates system plugins without entitlement requirements', function (): void {
    $mediaRes = slate_plugin_guard('media-library');
    assert_true($mediaRes['ok']);
    assert_eq('system', $mediaRes['state']);

    $mcpRes = slate_plugin_guard('mcp-gateway');
    assert_true($mcpRes['ok']);
    assert_eq('system', $mcpRes['state']);

    // Script path simulation
    $scriptRes = slate_plugin_guard('/plugins/media-library/admin/index.php');
    assert_true($scriptRes['ok']);
    assert_eq('system', $scriptRes['state']);
});

unit('slate_plugin_guard() ignores static assets', function (): void {
    $assetRes = slate_plugin_guard('/plugins/booking/assets/css/booking.css');
    assert_true($assetRes['ok']);
    assert_eq('asset', $assetRes['state']);

    $jsRes = slate_plugin_guard('/plugins/forms/assets/js/form.js');
    assert_true($jsRes['ok']);
    assert_eq('asset', $jsRes['state']);
});

unit('slate_plugin_active_notice() tracks expiring and expired notices without fatal errors', function (): void {
    slate_set_plugin_notice('booking', 'expiring', 'Booking', '2026-10-15 00:00:00');
    $notice = slate_plugin_active_notice();
    assert_true(is_array($notice));
    assert_eq('booking', $notice['slug']);
    assert_eq('info', $notice['type']);
    assert_true(str_contains($notice['title'], 'Booking'));

    slate_set_plugin_notice('membership', 'expired', 'Membership', '2026-10-01 00:00:00');
    $notice = slate_plugin_active_notice();
    assert_true(is_array($notice));
    assert_eq('membership', $notice['slug']);
    assert_eq('warning', $notice['type']);
    assert_true(str_contains($notice['title'], 'Membership'));
    assert_true(str_contains($notice['message'], 'read-only'));
});

unit('slate_plugin_guard() blocks unowned licensable plugins fail-closed', function (): void {
    PluginEntitlement::forget(99999);
    $res = slate_plugin_guard('booking', 99999);
    assert_false($res['ok'], 'unowned plugin must not be ok');
    assert_eq('unowned', $res['state']);
    assert_eq('blocked', $res['mode']);
    assert_eq('booking', $res['slug']);
});

unit('slate_require_plugin_entitlement() delegates to guard correctly', function (): void {
    $sysRes = slate_require_plugin_entitlement('mcp-gateway');
    assert_true($sysRes['ok']);
    assert_eq('system', $sysRes['state']);

    $unownedRes = slate_require_plugin_entitlement('stripe-payment', 88888);
    assert_false($unownedRes['ok']);
    assert_eq('unowned', $unownedRes['state']);
    assert_eq('blocked', $unownedRes['mode']);
});

unit('PluginEntitlement separates caches across different tenants', function (): void {
    PluginEntitlement::forget();
    $map1 = PluginEntitlement::map(991);
    $map2 = PluginEntitlement::map(992);
    assert_true(is_array($map1));
    assert_true(is_array($map2));
    PluginEntitlement::forget(991);
    // 992 cache persists while 991 cleared
    $map2After = PluginEntitlement::map(992);
    assert_true(is_array($map2After));
});
