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

/** Canonical sellable plugins catalogue shipped with Slate. */
function shop_canonical_plugins(): array
{
    return [
        'booking' => [
            'slug' => 'booking',
            'name' => 'Booking',
            'version' => '0.8.0',
            'description' => 'Full appointment booking, including the practitioner-logic capabilities absorbed from the Booking+ plugin. Services with categories, locations, resources, add-ons, per-staff pricing and group tiers; provider schedules with breaks and date overrides; group, recurring and walk-in bookings; an embeddable /book widget with self-service cancel and reschedule; Stripe payments (free/full/deposit), coupons, gift cards, refunds and invoices; email and SMS/WhatsApp reminders.',
            'category' => 'Operations',
            'tagline' => 'Appointments, payments and reminders in one place',
            'requires_core' => '>=1.0.0',
            'monthly_cents' => 1900,
            'yearly_cents' => 19000,
            'lifetime_cents' => 49000,
            'features' => [
                'Services, categories, locations and resources',
                'Provider schedules with breaks and overrides',
                'Embeddable /book self-service widget',
                'Stripe payments, deposits, coupons and gift cards',
                'Email and SMS/WhatsApp reminders',
            ],
            'order' => 10,
        ],
        'coaching' => [
            'slug' => 'coaching',
            'name' => 'Coaching',
            'version' => '0.6.0',
            'description' => 'The 3-month Body & Soul Program — daily tracking, coaching, and communication for clients who have downloaded the program. Layers on top of the membership plugin (fixed-term access) and integrates with booking\'s follow-up service. Wave 1 ships profile + goals foundation. Wave 2 adds food diary (meals, foods with manual classification, photos), hydration log, physical activity, emotion tracking with hunger/satiety context, and a practitioner-side live feed.',
            'category' => 'Operations',
            'tagline' => 'Daily tracking and coaching for client programs',
            'requires_core' => '>=1.0.0',
            'monthly_cents' => 1700,
            'yearly_cents' => 17000,
            'lifetime_cents' => 44000,
            'features' => [
                'Food diary, hydration, physical activity & emotion logs',
                'Practitioner live feed and client progress tracking',
                'Template library and program enrolment',
                'Integrates with Membership and Booking',
            ],
            'order' => 20,
        ],
        'membership' => [
            'slug' => 'membership',
            'name' => 'Membership',
            'version' => '0.7.1',
            'description' => 'Membership plans, lifecycle and the member layer on top of core customers — fixed-term plans (annual membership, insurance, course-specific) with FR/EN names + descriptions, pricing, duration and grace period; member profiles (gender, DOB, skill level, medical/allergies, emergency contact, consent) with a QR member card; a per-member wallet + transaction ledger; Stripe checkout via the stripe-payment plugin; admin manual/offline activation; and an active-membership gate that integrates with the Booking plugin.',
            'category' => 'Operations',
            'tagline' => 'Membership plans, member profiles, and digital cards',
            'requires_core' => '>=1.0.0',
            'monthly_cents' => 1500,
            'yearly_cents' => 15000,
            'lifetime_cents' => 39000,
            'features' => [
                'Members-only content gating',
                'Tiered membership levels',
                'Recurring billing support',
                'Member self-service portal',
            ],
            'order' => 25,
        ],
        'stripe-payment' => [
            'slug' => 'stripe-payment',
            'name' => 'Stripe Payment Gateway',
            'version' => '1.2.1',
            'description' => 'Generic Stripe checkout for any Slate plugin (v1.2). Exposes StripePaymentAPI::createCheckout(lineItems, opts) so plugins don\'t need their own Stripe wiring. Fires a stripe_webhook_event action so consumers can react to events. Includes a Charges admin page with refund support and a test/live mode toggle. Continues to drive Shop checkout (hosted + embedded Payment Element).',
            'category' => 'Payments',
            'tagline' => 'Accept card payments across your site',
            'requires_core' => '>=1.0.0',
            'monthly_cents' => 1200,
            'yearly_cents' => 12000,
            'lifetime_cents' => 29000,
            'features' => [
                'Hosted and embedded checkout',
                'Terminal / in-person payments',
                'Refunds and invoices',
                'Signed webhooks with idempotency',
            ],
            'order' => 30,
        ],
        'forms' => [
            'slug' => 'forms',
            'name' => 'Forms',
            'version' => '0.7.5',
            'description' => 'Public-facing forms — contact, quote requests, intake. Drop a form on any URL with /forms/<slug> or iframe-embed it. Submissions appear in the admin inbox; each submit fires an optional webhook and emails the admin + submitter.',
            'category' => 'Content',
            'tagline' => 'Build and embed contact and intake forms',
            'requires_core' => '>=1.0.0',
            'monthly_cents' => 900,
            'yearly_cents' => 9000,
            'lifetime_cents' => 24000,
            'features' => [
                'Drag-and-drop form builder',
                'File uploads and spam protection',
                'Per-form notification routing',
                'Submissions inbox and export',
            ],
            'order' => 40,
        ],
        'multilang-translate' => [
            'slug' => 'multilang-translate',
            'name' => 'Slate Multi Language Visual Translation',
            'version' => '1.3.0',
            'description' => 'Visual multi-language translation manager. Auto-harvests every text string rendered across admin, customer portal, frontend and all active plugins into a spreadsheet-style grid (columns = languages), lets you translate, find & replace, import/export CSV, and serves live translations through a front-end language switcher.',
            'category' => 'Content',
            'tagline' => 'Visual translation for a multilingual site',
            'requires_core' => '>=1.0.0',
            'monthly_cents' => 1100,
            'yearly_cents' => 11000,
            'lifetime_cents' => 27000,
            'features' => [
                'Inline visual translation editor',
                'Per-page language switching',
                'Locale-aware routing and SEO tags',
                'Translation memory reuse',
            ],
            'order' => 60,
        ],
        'backups' => [
            'slug' => 'backups',
            'name' => 'Backups',
            'version' => '1.0.0',
            'description' => 'Automated daily backup of the whole database and uploaded files, synced to Google Drive, with retention pruning and a manual "run now" option. Superadmin-only.',
            'category' => 'System',
            'tagline' => 'Scheduled backups to local or Google Drive',
            'requires_core' => '>=1.0.0',
            'monthly_cents' => 800,
            'yearly_cents' => 8000,
            'lifetime_cents' => 19000,
            'features' => [
                'Scheduled full and database backups',
                'Google Drive remote storage',
                'One-click restore',
                'Retention policies',
            ],
            'order' => 70,
        ],
    ];
}

/**
 * Returns available plugins catalogue from Master Dashboard API,
 * falling back to local canonical definitions.
 *
 * @return array<string, array<string, mixed>>
 */
function shop_master_plugins_catalog(): array
{
    static $cached = null;
    if ($cached !== null) {
        return $cached;
    }

    $catalog = shop_canonical_plugins();
    $masterUrl = shop_master_url();
    if ($masterUrl !== '') {
        $endpoint = rtrim($masterUrl, '/') . '/api/plugins/catalog';
        $json = null;
        if (function_exists('curl_init')) {
            $ch = curl_init($endpoint);
            if ($ch) {
                curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
                curl_setopt($ch, CURLOPT_TIMEOUT, 3);
                curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
                $resp = curl_exec($ch);
                $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
                curl_close($ch);
                if ($code === 200 && is_string($resp)) {
                    $json = $resp;
                }
            }
        }
        if (!$json) {
            $ctx = stream_context_create(['http' => ['timeout' => 3]]);
            $resp = @file_get_contents($endpoint, false, $ctx);
            if (is_string($resp)) {
                $json = $resp;
            }
        }
        if ($json) {
            $data = json_decode($json, true);
            if (is_array($data) && !empty($data['success']) && is_array($data['plugins'] ?? null)) {
                foreach ($data['plugins'] as $p) {
                    if (empty($p['slug']) || empty($p['licensable']) || !empty($p['system'])) continue;
                    $slug = (string)$p['slug'];
                    $price = is_array($p['price'] ?? null) ? $p['price'] : [];
                    $shop = is_array($p['shop'] ?? null) ? $p['shop'] : [];
                    $catalog[$slug] = [
                        'slug' => $slug,
                        'name' => (string)($p['name'] ?? $slug),
                        'version' => (string)($p['version'] ?? '—'),
                        'description' => (string)($p['description'] ?? ''),
                        'category' => (string)($shop['category'] ?? 'Other'),
                        'tagline' => (string)($shop['tagline'] ?? $p['description'] ?? ''),
                        'requires_core' => (string)($p['requires_core'] ?? '>=1.0.0'),
                        'monthly_cents' => (int)($price['monthly_cents'] ?? 0),
                        'yearly_cents' => (int)($price['yearly_cents'] ?? 0),
                        'lifetime_cents' => (int)($price['lifetime_cents'] ?? 0),
                        'features' => array_values(array_map('strval', is_array($shop['features'] ?? null) ? $shop['features'] : [])),
                        'order' => (int)($shop['order'] ?? 100),
                    ];
                }
            }
        }
    }

    $cached = $catalog;
    return $cached;
}

/** Return true only for a local, explicitly licensable plugin manifest, or canonical catalogue plugin. */
function shop_is_valid_plugin_slug(string $slug): bool
{
    if ($slug === '' || !preg_match('/^[a-z0-9][a-z0-9-]*$/', $slug)) return false;
    $manifestPath = (defined('SLATE_ROOT') ? SLATE_ROOT : dirname(__DIR__)) . '/plugins/' . $slug . '/plugin.json';
    if (is_file($manifestPath)) {
        $manifest = json_decode((string) @file_get_contents($manifestPath), true);
        if (is_array($manifest) && ($manifest['slug'] ?? '') === $slug && !empty($manifest['licensable']) && empty($manifest['system'])) {
            return true;
        }
    }
    $canonical = shop_canonical_plugins();
    return isset($canonical[$slug]);
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

/**
 * Activate a license key (core package or standalone plugin) via Master authority.
 * Installs the key in .env, updates the local database (licenses / plugin_licenses),
 * writes restrictions, and flushes entitlement caches.
 *
 * @return array{ok:bool, message?:string, error?:string}
 */
function shop_activate_license_key(string $key): array
{
    $key = strtoupper(trim($key));
    $key = trim($key, '"\'');
    $key = preg_replace('/[\s_]+/', '-', $key);
    if (preg_match('/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/i', $key)) {
        $key = 'SLT-' . $key;
    }
    if (!preg_match('/^SLT-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/i', $key)) {
        return ['ok' => false, 'error' => 'Invalid license key format. Expected SLT-XXXX-XXXX-XXXX-XXXX.'];
    }

    $masterUrl = shop_master_url();
    if ($masterUrl === '') {
        if (class_exists('\\Slate\\Services\\Licensing\\LicenseClient')) {
            $masterUrl = \Slate\Services\Licensing\LicenseClient::masterUrl();
        }
    }
    if ($masterUrl === '') {
        $masterUrl = (string)(function_exists('env') ? env('LICENSE_MASTER_URL', '') : (getenv('LICENSE_MASTER_URL') ?: ''));
    }
    if ($masterUrl === '') {
        $masterUrl = 'https://slate-master-dashboard.onrender.com';
    }

    $domain = '';
    if (defined('SLATE_URL') && SLATE_URL !== '') {
        $domain = SLATE_URL;
    } elseif (function_exists('env') && env('APP_URL')) {
        $domain = env('APP_URL');
    } elseif (!empty($_SERVER['HTTP_HOST'])) {
        $scheme = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on') ? 'https' : 'http';
        $domain = $scheme . '://' . $_SERVER['HTTP_HOST'];
    }

    $payload = json_encode(['key' => $key, 'domain' => $domain]);
    $endpoint = rtrim($masterUrl, '/') . '/api/licenses/activate';
    $raw = false;

    if (function_exists('curl_init')) {
        $ch = curl_init($endpoint);
        if ($ch) {
            curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
            curl_setopt($ch, CURLOPT_POST, true);
            curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
            curl_setopt($ch, CURLOPT_HTTPHEADER, [
                'Content-Type: application/json',
                'Accept: application/json',
            ]);
            curl_setopt($ch, CURLOPT_TIMEOUT, 15);
            curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
            $raw = curl_exec($ch);
            curl_close($ch);
        }
    }
    if ($raw === false || $raw === '' || $raw === null) {
        $ctx = stream_context_create([
            'http' => [
                'method'  => 'POST',
                'header'  => "Content-Type: application/json\r\nAccept: application/json\r\n",
                'content' => $payload,
                'timeout' => 15,
            ],
        ]);
        $raw = @file_get_contents($endpoint, false, $ctx);
    }
    if (!$raw) {
        return ['ok' => false, 'error' => 'Could not connect to Master license authority. Please check your network and try again.'];
    }

    $data = json_decode((string)$raw, true);
    if (!is_array($data) || empty($data['success'])) {
        $errMsg = is_array($data) && !empty($data['error']) ? (string)$data['error'] : 'License validation failed.';
        return ['ok' => false, 'error' => $errMsg];
    }

    // 1. Install LICENSE_KEY into in-memory environment and .env file
    $_ENV['LICENSE_KEY'] = $key;
    putenv("LICENSE_KEY={$key}");

    $root = defined('SLATE_ROOT') ? SLATE_ROOT : dirname(__DIR__);
    $envPath = $root . '/.env';
    if (file_exists($envPath)) {
        $env = (string)@file_get_contents($envPath);
        $lines = explode("\n", $env);
        $newLine = 'LICENSE_KEY="' . addslashes($key) . '"';
        $found = false;
        foreach ($lines as $i => $ln) {
            if (preg_match('/^LICENSE_KEY=.*$/', rtrim($ln, "\r"))) {
                $lines[$i] = $newLine;
                $found = true;
                break;
            }
        }
        if (!$found) {
            $env = rtrim($env, "\r\n") . "\n" . $newLine;
        } else {
            $env = implode("\n", $lines);
        }
        @file_put_contents($envPath, $env);
    } else {
        @file_put_contents($envPath, "LICENSE_KEY=\"" . addslashes($key) . "\"\n");
    }

    $tenantId = function_exists('current_tenant_id') ? (int)current_tenant_id() : 1;
    $lic = $data['license'] ?? [];
    $pkg = $data['package'] ?? null;
    $pluginEntitlements = $data['pluginEntitlements'] ?? [];

    $keyHash = hash('sha256', $key);
    $keyLast4 = substr($key, -4);
    $status = (string)($lic['status'] ?? 'active');
    $expiresAt = !empty($lic['expires_at']) ? (string)$lic['expires_at'] : null;
    $billingCycle = !empty($lic['billing_cycle']) ? (string)$lic['billing_cycle'] : 'yearly';
    $packageSlug = $pkg['slug'] ?? ($lic['package_slug'] ?? null);

    // 2. Database persistence
    if (class_exists('Database')) {
        try {
            if ($pkg !== null || !empty($lic['package_id']) || $packageSlug !== null) {
                $existing = \Database::row("SELECT id FROM licenses WHERE tenant_id = ? ORDER BY id DESC LIMIT 1", [$tenantId]);
                if ($existing && !empty($existing['id'])) {
                    \Database::query(
                        "UPDATE licenses SET
                          license_key_hash = ?,
                          status = ?,
                          expires_at = ?,
                          domain = COALESCE(?, domain),
                          billing_cycle = ?,
                          package_slug = COALESCE(?, package_slug),
                          last_validated_at = NOW(),
                          updated_at = NOW()
                         WHERE id = ?",
                        [$keyHash, $status, $expiresAt, $domain, $billingCycle, $packageSlug, $existing['id']]
                    );
                } else {
                    \Database::insert('licenses', [
                        'tenant_id'         => $tenantId,
                        'license_key_hash'  => $keyHash,
                        'status'            => $status,
                        'domain'            => $domain,
                        'billing_cycle'     => $billingCycle,
                        'package_slug'      => $packageSlug,
                        'expires_at'        => $expiresAt,
                        'activation_limit'  => 1,
                        'activation_count'  => 1,
                        'last_validated_at' => date('Y-m-d H:i:s'),
                    ]);
                }

                if (!empty($pkg['restrictions']) && is_array($pkg['restrictions'])) {
                    $restPath = $root . '/.slate_restrictions.json';
                    @file_put_contents($restPath, json_encode(array_values($pkg['restrictions']), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
                }
            }

            if (empty($pluginEntitlements) && !empty($lic['package_slug']) && !$pkg) {
                $pluginEntitlements[$lic['package_slug']] = [
                    'source'     => 'single',
                    'status'     => $status,
                    'expires_at' => $expiresAt,
                ];
            }

            if (!empty($pluginEntitlements) && is_array($pluginEntitlements)) {
                foreach ($pluginEntitlements as $slug => $ent) {
                    $entStatus = (string)($ent['status'] ?? 'active');
                    $entSource = (string)($ent['source'] ?? 'package');
                    $entExpires = !empty($ent['expires_at']) ? (string)$ent['expires_at'] : $expiresAt;
                    \Database::query(
                        "INSERT INTO plugin_licenses
                          (tenant_id, plugin_slug, domain, license_key_hash, license_key_last4,
                           status, billing_cycle, source, source_package_slug, starts_at, expires_at,
                           activation_limit, activation_count, last_validated_at, created_at, updated_at)
                         VALUES
                          (?, ?, ?, ?, ?,
                           ?, ?, ?, ?, NOW(), ?,
                           1, 1, NOW(), NOW(), NOW())
                         ON DUPLICATE KEY UPDATE
                          status = VALUES(status),
                          expires_at = VALUES(expires_at),
                          source = VALUES(source),
                          source_package_slug = VALUES(source_package_slug),
                          last_validated_at = NOW(),
                          updated_at = NOW()",
                        [
                            $tenantId, $slug, $domain, $keyHash, $keyLast4,
                            $entStatus, $billingCycle, $entSource, $packageSlug, $entExpires
                        ]
                    );
                }
            }
        } catch (\Throwable $e) {
            // best-effort DB update
        }
    }

    // 3. Invalidate entitlement cache
    if (class_exists('\\Slate\\Services\\Licensing\\PluginEntitlement')) {
        \Slate\Services\Licensing\PluginEntitlement::forget();
    }

    return [
        'ok'      => true,
        'message' => 'License key successfully activated! Full access has been restored.',
    ];
}
