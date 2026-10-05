<?php
/**
 * Slate — LicenseCatalog: tenant-scoped read model for customer licensing UI.
 *
 * This service deliberately keeps presentation pages away from raw licensing
 * queries. It normalizes core/package and standalone-plugin rows, preserves
 * package provenance, and fails closed to an empty read model when an older
 * client has not run the optional licensing migrations yet.
 */
declare(strict_types=1);

namespace Slate\Services\Licensing;

final class LicenseCatalog
{
    private const PASS = ['active', 'trial'];
    private const BLOCKED = ['suspended', 'revoked', 'cancelled'];

    /** @return array{core:?array,plugins:array<int,array<string,mixed>>,items:array<int,array<string,mixed>>} */
    public static function forTenant(int $tenantId): array
    {
        $core = self::coreLicense($tenantId);
        $plugins = self::pluginLicenses($tenantId);
        $items = [];

        if ($core !== null) {
            $items[] = self::normalizeCore($core);
        }
        foreach ($plugins as $license) {
            $items[] = self::normalizePlugin($license);
        }

        return ['core' => $core, 'plugins' => $plugins, 'items' => $items];
    }

    public static function forCurrentTenant(): array
    {
        $tenantId = function_exists('current_tenant_id') ? (int) current_tenant_id() : 1;
        return self::forTenant(max(1, $tenantId));
    }

    public static function coreLicense(int $tenantId): ?array
    {
        try {
            return \Database::row(
                'SELECT * FROM licenses WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
                [$tenantId]
            );
        } catch (\Throwable $e) {
            return null;
        }
    }

    /** @return array<int,array<string,mixed>> */
    public static function pluginLicenses(int $tenantId): array
    {
        try {
            return \Database::rows(
                "SELECT * FROM plugin_licenses
                  WHERE tenant_id = ?
               ORDER BY FIELD(status, 'active', 'trial', 'expired', 'suspended', 'revoked', 'cancelled'),
                        created_at DESC, id DESC",
                [$tenantId]
            );
        } catch (\Throwable $e) {
            return [];
        }
    }

    /** Normalize a stored status and apply lazy expiry without mutating storage. */
    public static function status(?string $status, ?string $expiresAt = null): string
    {
        $status = strtolower(trim((string) $status));
        if (in_array($status, self::BLOCKED, true)) {
            return $status;
        }
        if ($status === 'expired') {
            return 'expired';
        }
        if (!in_array($status, self::PASS, true)) {
            return 'unowned';
        }
        if ($expiresAt !== null && $expiresAt !== '' && strtotime($expiresAt) !== false) {
            $remaining = strtotime($expiresAt) - time();
            if ($remaining <= 0) {
                return 'expired';
            }
            if ($remaining <= 7 * 86400) {
                return 'expiring';
            }
        }
        return $status;
    }

    public static function canRenew(array $item): bool
    {
        $source = strtolower((string) ($item['source'] ?? ''));
        $status = strtolower((string) ($item['status'] ?? ''));
        return !empty($item['license_id'])
            && $source !== 'package'
            && !in_array($status, ['revoked', 'cancelled'], true);
    }

    /** @return array<string,mixed> */
    private static function normalizeCore(array $license): array
    {
        $metadata = self::metadata($license['metadata'] ?? null);
        $packageSlug = (string) ($metadata['package_slug'] ?? $metadata['pack_slug'] ?? '');
        $status = self::status($license['status'] ?? null, $license['expires_at'] ?? null);

        return [
            'product_type' => 'core',
            'product_slug' => 'slate-core',
            'product_name' => 'Slate Core',
            'license_id' => isset($license['id']) ? (int) $license['id'] : null,
            'source' => 'package',
            'package_slug' => $packageSlug !== '' ? $packageSlug : null,
            'status' => $status,
            'stored_status' => (string) ($license['status'] ?? ''),
            'starts_at' => $license['starts_at'] ?? $license['issued_at'] ?? null,
            'expires_at' => $license['expires_at'] ?? null,
            'billing_cycle' => $license['billing_cycle'] ?? ($metadata['billing_cycle'] ?? null),
            'key_last4' => null,
            'renewable' => !in_array($status, ['revoked', 'cancelled'], true),
            'metadata' => $metadata,
        ];
    }

    /** @return array<string,mixed> */
    private static function normalizePlugin(array $license): array
    {
        $metadata = self::metadata($license['metadata'] ?? null);
        $source = strtolower((string) ($license['source'] ?? 'single'));
        $packageSlug = (string) ($license['source_package_slug'] ?? '');
        if ($packageSlug === '') {
            $packageSlug = (string) ($metadata['package_slug'] ?? $metadata['pack_slug'] ?? '');
        }
        $status = self::status($license['status'] ?? null, $license['expires_at'] ?? null);

        $item = [
            'product_type' => 'plugin',
            'product_slug' => (string) ($license['plugin_slug'] ?? ''),
            'product_name' => (string) ($metadata['name'] ?? ucfirst((string) ($license['plugin_slug'] ?? ''))),
            'license_id' => isset($license['id']) ? (int) $license['id'] : null,
            'source' => $source,
            'package_slug' => $packageSlug !== '' ? $packageSlug : null,
            'status' => $status,
            'stored_status' => (string) ($license['status'] ?? ''),
            'starts_at' => $license['starts_at'] ?? null,
            'expires_at' => $license['expires_at'] ?? null,
            'billing_cycle' => $license['billing_cycle'] ?? null,
            'key_last4' => $license['license_key_last4'] ?? null,
            'metadata' => $metadata,
        ];
        $item['renewable'] = self::canRenew($item);
        return $item;
    }

    /** @return array<string,mixed> */
    private static function metadata($raw): array
    {
        if (is_array($raw)) {
            return $raw;
        }
        if (!is_string($raw) || trim($raw) === '') {
            return [];
        }
        $decoded = json_decode($raw, true);
        return is_array($decoded) ? $decoded : [];
    }
}
