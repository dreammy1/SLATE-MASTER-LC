<?php
/**
 * Phase 1 — LicenseCatalog pure rules.
 *
 * These tests do not boot config.php or touch a database; tenant-query behavior
 * is covered by the existing integration database suite.
 */

declare(strict_types=1);

use Slate\Services\Licensing\LicenseCatalog;

unit('LicenseCatalog::status() preserves active and trial states', function (): void {
    assert_eq('active', LicenseCatalog::status('active'));
    assert_eq('trial', LicenseCatalog::status('trial'));
});

unit('LicenseCatalog::status() lazily marks expired and expiring licenses', function (): void {
    assert_eq('expired', LicenseCatalog::status('active', '2000-01-01 00:00:00'));
    assert_eq('expiring', LicenseCatalog::status('active', date('Y-m-d H:i:s', time() + 3600)));
    assert_eq('expired', LicenseCatalog::status('expired', date('Y-m-d H:i:s', time() + 86400)));
});

unit('LicenseCatalog::status() preserves blocked states and fails unknown states closed', function (): void {
    assert_eq('suspended', LicenseCatalog::status('suspended'));
    assert_eq('revoked', LicenseCatalog::status('revoked'));
    assert_eq('cancelled', LicenseCatalog::status('cancelled'));
    assert_eq('unowned', LicenseCatalog::status('garbage'));
    assert_eq('unowned', LicenseCatalog::status(null));
});

unit('LicenseCatalog::canRenew() allows standalone licenses but not package-included rows', function (): void {
    assert_true(LicenseCatalog::canRenew([
        'license_id' => 7,
        'source' => 'single',
        'status' => 'active',
    ]));
    assert_false(LicenseCatalog::canRenew([
        'license_id' => 8,
        'source' => 'package',
        'status' => 'active',
    ]));
    assert_false(LicenseCatalog::canRenew([
        'license_id' => 9,
        'source' => 'single',
        'status' => 'revoked',
    ]));
    assert_false(LicenseCatalog::canRenew([
        'license_id' => null,
        'source' => 'single',
        'status' => 'active',
    ]));
});
