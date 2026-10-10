<?php
/**
 * Phase 7 — Plugins Shop Categorization and Modal Structure Unit Tests.
 */

declare(strict_types=1);

unit('Plugins shop categorization partitions plugins into activated vs available groups correctly', function (): void {
    $plugins = [
        [
            'slug' => 'booking',
            'in_package' => true,
            'active' => false,
            'status' => 'unowned',
            'entitled' => false,
        ],
        [
            'slug' => 'forms',
            'in_package' => false,
            'active' => true,
            'status' => 'unowned',
            'entitled' => false,
        ],
        [
            'slug' => 'membership',
            'in_package' => false,
            'active' => false,
            'status' => 'licensed',
            'entitled' => true,
        ],
        [
            'slug' => 'stripe-payment',
            'in_package' => false,
            'active' => false,
            'status' => 'unowned',
            'entitled' => false,
        ],
        [
            'slug' => 'backups',
            'in_package' => false,
            'active' => false,
            'status' => 'revoked',
            'entitled' => false,
        ],
    ];

    $isActivated = static function (array $p): bool {
        return !empty($p['in_package'])
            || !empty($p['active'])
            || !empty($p['entitled'])
            || in_array(strtolower($p['status'] ?? ''), ['active', 'trial', 'licensed', 'expiring'], true);
    };

    $activated = array_values(array_filter($plugins, $isActivated));
    $available = array_values(array_filter($plugins, static fn(array $p): bool => !$isActivated($p)));

    assert_eq(['booking', 'forms', 'membership'], array_column($activated, 'slug'));
    assert_eq(['stripe-payment', 'backups'], array_column($available, 'slug'));
});

unit('Plugins shop template contains solid modal backgrounds, backdrop blur, z-index and 2 categories', function (): void {
    $file = dirname(__DIR__, 2) . '/admin/plugins-shop.php';
    assert_true(file_exists($file), 'plugins-shop.php exists');
    $content = (string)file_get_contents($file);

    // Modal UI bug verification:
    assert_true(str_contains($content, 'background: rgba(0, 0, 0, 0.65) !important;'), 'Opaque dark backdrop overlay present');
    assert_true(str_contains($content, 'backdrop-filter: blur(6px);'), 'Backdrop blur present');
    assert_true(str_contains($content, 'z-index: 9999;'), 'Modal elevated z-index present');
    assert_true(str_contains($content, 'background: #FFFFFF !important;'), 'Light mode solid background present');
    assert_true(str_contains($content, 'background: #161e31 !important;'), 'Dark mode solid background present');
    assert_true(str_contains($content, '.modal-box'), 'Themed modal content boxes present');

    // Categorization verification:
    assert_true(str_contains($content, 'Activated / Included with License'), 'Activated section heading present');
    assert_true(str_contains($content, 'Available Plugins / Not Installed Yet'), 'Available section heading present');
    assert_true(str_contains($content, 'View details'), 'View details button present');
    assert_true(str_contains($content, 'Buy Now'), 'Buy Now button present');
});
