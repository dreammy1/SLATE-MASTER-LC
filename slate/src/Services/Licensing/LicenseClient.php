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

    /**
     * Resolves the Master authority URL.
     */
    public static function masterUrl(): string
    {
        $master = (string)(\env('LICENSE_MASTER_URL', '') ?: '');
        if ($master !== '') {
            return rtrim($master, '/');
        }
        $agentConfig = (defined('SLATE_ROOT') ? SLATE_ROOT : dirname(__DIR__, 3)) . '/.slate_agent_config.json';
        if (file_exists($agentConfig)) {
            $raw = @file_get_contents($agentConfig);
            $parsed = $raw ? json_decode($raw, true) : null;
            if (!empty($parsed['master_host'])) {
                $host = (string)$parsed['master_host'];
                return (str_starts_with($host, 'http://') || str_starts_with($host, 'https://'))
                    ? rtrim($host, '/')
                    : 'https://' . rtrim($host, '/');
            }
        }
        return 'https://slate-master-dashboard.onrender.com';
    }

    /**
     * Path to local update info file.
     */
    private static function updateFilePath(): string
    {
        $root = defined('SLATE_ROOT') ? SLATE_ROOT : dirname(__DIR__, 3);
        return $root . '/.slate_update.json';
    }

    /**
     * Reads current available update info, if any.
     * @return array{hasUpdate:bool,latestRef:string,currentRef:string,checkedAt:string,package:?string,masterUrl:string}|null
     */
    public static function getAvailableUpdate(): ?array
    {
        $file = self::updateFilePath();
        if (!file_exists($file)) {
            return null;
        }
        $raw = @file_get_contents($file);
        $data = $raw ? json_decode($raw, true) : null;
        if (!is_array($data) || empty($data['latestRef'])) {
            return null;
        }
        $current = defined('SLATE_VERSION') ? (string)SLATE_VERSION : '1.0.0';
        $hasUpdate = $data['latestRef'] !== $current;
        if (!$hasUpdate) {
            return null;
        }
        return [
            'hasUpdate'  => true,
            'latestRef'  => (string)$data['latestRef'],
            'currentRef' => $current,
            'checkedAt'  => (string)($data['checkedAt'] ?? ''),
            'package'    => $data['package'] ?? null,
            'masterUrl'  => (string)($data['masterUrl'] ?? self::masterUrl()),
        ];
    }

    public static function heartbeatMaybe(array $license, bool $force = false): void
    {
        try {
            $last = !empty($license['last_validated_at']) ? strtotime((string)$license['last_validated_at']) : 0;
            if (!$force && (time() - $last) < self::HEARTBEAT_HOURS * 3600) return;
            $master = self::masterUrl();
            if ($master === '') return;

            $currentVer = defined('SLATE_VERSION') ? SLATE_VERSION : '1.0.0';
            $payload = [
                'key_hash'        => $license['license_key_hash'] ?? '',
                'domain'          => \env('APP_URL', ''),
                'current_version' => $currentVer,
            ];

            $ctx = stream_context_create(['http' => [
                'method'  => 'POST',
                'header'  => "Content-Type: application/json\r\nAccept: application/json\r\n",
                'content' => json_encode($payload),
                'timeout' => 5,
            ]]);
            $raw = @file_get_contents($master . '/api/licenses/heartbeat', false, $ctx);
            if ($raw) {
                $res = json_decode($raw, true);
                if (is_array($res) && !empty($res['latestRef'])) {
                    $updateRecord = [
                        'latestRef'  => $res['latestRef'],
                        'currentRef' => $currentVer,
                        'hasUpdate'  => $res['latestRef'] !== $currentVer,
                        'package'    => $res['package'] ?? null,
                        'checkedAt'  => date('c'),
                        'masterUrl'  => $res['masterUrl'] ?? $master,
                        'clientId'   => $res['clientId'] ?? '',
                    ];
                    @file_put_contents(self::updateFilePath(), json_encode($updateRecord, JSON_PRETTY_PRINT));
                }
                
                // Only update last_validated_at upon a successful heartbeat response
                \Database::query("UPDATE licenses SET last_validated_at = ? WHERE id = ?", [\slate_db_now(), $license['id']]);
            }
        } catch (\Throwable $e) { /* best-effort */ }
    }

    /**
     * Triggers a remote push-update from Master for this site.
     * @return array{ok:bool,message:string}
     */
    public static function triggerUpdate(): array
    {
        try {
            $tenantId = \current_tenant_id();
            $license = LicenseService::forTenant($tenantId);
            if (!$license) {
                return ['ok' => false, 'message' => 'No active license found on this site.'];
            }
            $master = self::masterUrl();
            if ($master === '') {
                return ['ok' => false, 'message' => 'Master authority URL could not be resolved.'];
            }

            $update = self::getAvailableUpdate();
            $targetRef = $update['latestRef'] ?? null;

            $ctx = stream_context_create(['http' => [
                'method'  => 'POST',
                'header'  => "Content-Type: application/json\r\nAccept: application/json\r\n",
                'content' => json_encode([
                    'key_hash' => $license['license_key_hash'] ?? '',
                    'domain'   => \env('APP_URL', ''),
                    'ref'      => $targetRef,
                ]),
                'timeout' => 120,
            ]]);

            $raw = @file_get_contents($master . '/api/licenses/update-request', false, $ctx);
            if (!$raw) {
                return ['ok' => false, 'message' => 'Master did not respond to the update request.'];
            }
            $res = json_decode($raw, true);
            if (!is_array($res)) {
                return ['ok' => false, 'message' => 'Invalid response from Master update endpoint.'];
            }
            if (!empty($res['success'])) {
                // Clear update notification file as update is complete
                @unlink(self::updateFilePath());
                return ['ok' => true, 'message' => $res['message'] ?? 'Update completed successfully.'];
            }
            return ['ok' => false, 'message' => $res['error'] ?? $res['message'] ?? 'Update failed.'];
        } catch (\Throwable $e) {
            return ['ok' => false, 'message' => 'Update request error: ' . $e->getMessage()];
        }
    }
}
