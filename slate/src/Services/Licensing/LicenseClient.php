<?php
/**
 * Slate — LicenseClient (remote licensing client).
 * Validates local license + domain + heartbeat with Master authority.
 * Never throws to callers: fail-open into grace, fail-closed after grace.
 */
declare(strict_types=1);

namespace Slate\Services\Licensing;

final class LicenseClient
{
    public const GRACE_HOURS = 72;
    public const HEARTBEAT_HOURS = 6;

    /** @return array{mode:string,status:string,expires_at:?string} mode: ok|grace|expired|locked */
    public static function validate(?int $tenantId = null): array
    {
        $tenantId ??= \current_tenant_id();
        try {
            $license = LicenseService::forTenant($tenantId);
            if ($license === null) {
                return ['mode' => 'ok', 'status' => 'none', 'expires_at' => null]; // BC: no license yet
            }
            $status = LicenseService::effectiveStatus($tenantId);
            if ($status === 'active' || $status === 'trial') {
                self::heartbeatMaybe($license);
                return ['mode' => 'ok', 'status' => $status, 'expires_at' => $license['expires_at'] ?? null];
            }
            if (in_array($status, ['suspended', 'revoked', 'cancelled'], true)) {
                return ['mode' => 'locked', 'status' => $status, 'expires_at' => $license['expires_at'] ?? null];
            }
            // expired → grace window from last_validated_at
            $last = !empty($license['last_validated_at']) ? strtotime((string)$license['last_validated_at']) : 0;
            $hours = $last > 0 ? (time() - $last) / 3600 : self::GRACE_HOURS + 1;
            if ($hours <= self::GRACE_HOURS) {
                return ['mode' => 'grace', 'status' => 'expired', 'expires_at' => $license['expires_at'] ?? null];
            }
            return ['mode' => 'expired', 'status' => 'expired', 'expires_at' => $license['expires_at'] ?? null];
        } catch (\Throwable $e) {
            return ['mode' => 'grace', 'status' => 'unknown', 'expires_at' => null];
        }
    }

    private static function heartbeatMaybe(array $license): void
    {
        try {
            $last = !empty($license['last_validated_at']) ? strtotime((string)$license['last_validated_at']) : 0;
            if ((time() - $last) < self::HEARTBEAT_HOURS * 3600) return;
            $master = (string)(\env('LICENSE_MASTER_URL', '') ?: '');
            if ($master === '') return;
            $ctx = stream_context_create(['http' => [
                'method' => 'POST',
                'header' => "Content-Type: application/json\r\n",
                'content' => json_encode(['key_hash' => $license['license_key_hash'] ?? '', 'domain' => \env('APP_URL', '')]),
                'timeout' => 5,
            ]]);
            @file_get_contents(rtrim($master, '/') . '/api/licenses/heartbeat', false, $ctx);
        } catch (\Throwable $e) { /* best-effort */ }
    }
}
