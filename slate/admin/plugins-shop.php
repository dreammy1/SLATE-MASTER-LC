<?php
require_once dirname(__DIR__) . '/config.php';
require_once __DIR__ . '/../includes/shop_client.php';

use Slate\Kernel\Module\PluginLoader;
use Slate\Services\Licensing\PluginEntitlement;

Auth::requirePerm('plugins.manage');

$currentNav = 'plugins-shop';
$pageTitle = 'Plugins Shop';
$licenseCatalog = shop_license_catalog();
$ownedItems = [];
foreach (($licenseCatalog['items'] ?? []) as $item) {
    if (($item['product_type'] ?? '') === 'plugin' && !empty($item['product_slug'])) {
        $ownedItems[(string)$item['product_slug']] = $item;
    }
}

$catalog = [];
$pluginsDir = __DIR__ . '/../plugins';
if (is_dir($pluginsDir)) {
    foreach (scandir($pluginsDir) as $dirName) {
        if ($dirName === '.' || $dirName === '..') continue;
        $manifestPath = $pluginsDir . '/' . $dirName . '/plugin.json';
        if (!is_file($manifestPath)) continue;
        $manifest = json_decode((string)file_get_contents($manifestPath), true);
        if (!is_array($manifest) || empty($manifest['licensable']) || empty($manifest['slug'])) continue;
        $slug = (string)$manifest['slug'];
        $price = is_array($manifest['price'] ?? null) ? $manifest['price'] : [];
        $shop = is_array($manifest['shop'] ?? null) ? $manifest['shop'] : [];
        $entitlement = shop_entitlement_info($slug);
        $owned = $ownedItems[$slug] ?? null;
        $source = (string)($owned['source'] ?? $entitlement['source'] ?? 'none');
        $packageSlug = (string)($owned['package_slug'] ?? $entitlement['package_slug'] ?? '');
        $status = (string)($owned['status'] ?? $entitlement['state'] ?? 'unowned');
        $active = false;
        try { $active = PluginLoader::isActive($slug); } catch (\Throwable $e) { $active = false; }

        $inPackage = ($source === 'package');
        $isActivated = $inPackage
            || $active
            || !empty($entitlement['entitled'])
            || in_array(strtolower($status), ['active', 'trial', 'licensed', 'expiring'], true);

        $catalog[] = [
            'slug' => $slug,
            'name' => (string)($manifest['name'] ?? $slug),
            'version' => (string)($manifest['version'] ?? '—'),
            'description' => (string)($manifest['description'] ?? ''),
            'tagline' => (string)($shop['tagline'] ?? $manifest['description'] ?? ''),
            'category' => (string)($shop['category'] ?? 'Other'),
            'features' => array_values(array_map('strval', is_array($shop['features'] ?? null) ? $shop['features'] : [])),
            'requires_core' => (string)($manifest['requires_core'] ?? ''),
            'monthly_cents' => (int)($price['monthly_cents'] ?? 0),
            'yearly_cents' => (int)($price['yearly_cents'] ?? 0),
            'lifetime_cents' => (int)($price['lifetime_cents'] ?? 0),
            'source' => $source,
            'package_slug' => $packageSlug,
            'status' => $status,
            'active' => $active,
            'in_package' => $inPackage,
            'is_activated' => $isActivated,
            'purchase_monthly' => shop_checkout_url($slug, 'monthly'),
            'purchase_yearly' => shop_checkout_url($slug, 'yearly'),
            'purchase_lifetime' => shop_checkout_url($slug, 'lifetime'),
        ];
    }
}
usort($catalog, static function (array $a, array $b): int {
    return strcasecmp($a['category'] . $a['name'], $b['category'] . $b['name']);
});

$activatedPlugins = array_values(array_filter($catalog, static fn(array $p): bool => !empty($p['is_activated'])));
$availablePlugins = array_values(array_filter($catalog, static fn(array $p): bool => empty($p['is_activated'])));

$money = static function (int $cents): string {
    return $cents > 0 ? '$' . number_format($cents / 100, 2) : '—';
};
$statusClass = static function (string $status): string {
    return match (strtolower($status)) {
        'active', 'trial', 'licensed' => 'success',
        'expiring' => 'warning',
        'expired' => 'warning',
        'blocked', 'suspended', 'revoked', 'cancelled' => 'danger',
        default => 'secondary',
    };
};

require __DIR__ . '/partials/header.php';
?>

<?php if (function_exists('slate_breadcrumbs')): ?>
    <?php slate_breadcrumbs([
        ['label' => __('dashboard', 'Dashboard'), 'href' => (defined('SLATE_URL') ? SLATE_URL : '') . '/admin/'],
        ['label' => 'Plugins Shop'],
    ]); ?>
<?php endif; ?>

<style>
:root {
    --border-color: var(--border, #ECEDEF);
    --border-strong-color: var(--border-strong, #E0E2E6);
    --card-bg: var(--surface, #FFFFFF);
    --text-muted: var(--muted, #71757E);
    --text-color: var(--text, #16181D);
    --input-bg: var(--surface, #FFFFFF);
    --surface-secondary: var(--surface-2, #F5F6F8);
}

.shop-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: .75rem;
    align-items: center;
    margin-bottom: 2rem;
    padding: 1rem 1.25rem;
    background: var(--card-bg);
    border: 1px solid var(--border-color);
    border-radius: 12px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.03);
}
.shop-toolbar .form-control, .shop-toolbar .form-select {
    min-width: 180px;
    flex: 1 1 180px;
}

.shop-sections-container {
    display: flex;
    flex-direction: column;
    gap: 2.75rem;
}

.shop-section {
    display: flex;
    flex-direction: column;
    gap: 1.15rem;
}

.shop-section-head {
    border-bottom: 1px solid var(--border-color);
    padding-bottom: 0.85rem;
}

.shop-section-title-wrap {
    display: flex;
    align-items: center;
    gap: 0.75rem;
}

.shop-section-title {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--text-color);
    display: flex;
    align-items: center;
    gap: 0.6rem;
}

.shop-section-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 6px;
}
.shop-section-icon-active {
    background: rgba(16, 185, 129, 0.12);
    color: #059669;
}
.shop-section-icon-available {
    background: rgba(99, 102, 241, 0.12);
    color: #4f46e5;
}

.shop-count-pill {
    font-size: 0.8rem;
    font-weight: 600;
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
}

.shop-section-desc {
    margin: 0.35rem 0 0;
    font-size: 0.88rem;
    color: var(--text-muted);
}

.shop-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1.15rem;
}

.shop-card {
    display: flex;
    flex-direction: column;
    min-height: 320px;
    border: 1px solid var(--border-color);
    border-radius: 12px;
    background: var(--card-bg);
    overflow: hidden;
    transition: transform .15s, box-shadow .15s, border-color .15s;
    box-shadow: 0 1px 4px rgba(0,0,0,0.03);
}
.shop-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.08);
    border-color: var(--border-strong-color);
}
.shop-card-head {
    padding: 1.1rem 1.2rem 0.85rem;
    border-bottom: 1px solid var(--border-color);
}
.shop-card-title {
    margin: 0;
    font-size: 1.05rem;
    font-weight: 650;
    color: var(--text-color);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
}
.shop-meta {
    display: flex;
    flex-wrap: wrap;
    gap: .4rem;
    margin-top: .5rem;
}
.shop-card-body {
    display: flex;
    flex: 1;
    flex-direction: column;
    padding: 1.1rem 1.2rem;
}
.shop-tagline {
    min-height: 2.5rem;
    margin: .35rem 0 .75rem;
    color: var(--text-muted);
    font-size: .88rem;
    line-height: 1.45;
}
.shop-features {
    margin: 0 0 1.25rem;
    padding-left: 1.15rem;
    color: var(--text-color);
    font-size: .84rem;
    line-height: 1.5;
}
.shop-price {
    margin-top: auto;
    color: var(--primary, #4f46e5);
    font-size: 1.1rem;
    font-weight: 700;
}
.shop-price small {
    color: var(--text-muted);
    font-weight: 400;
    font-size: .84rem;
}
.shop-price-owned {
    color: #059669;
    font-size: 0.95rem;
    font-weight: 650;
    display: flex;
    align-items: center;
    gap: 0.35rem;
}
.shop-card-actions {
    display: flex;
    gap: .6rem;
    padding: 1rem 1.2rem;
    border-top: 1px solid var(--border-color);
    background: var(--card-bg);
}
.shop-card-actions .btn {
    flex: 1;
    white-space: nowrap;
    text-align: center;
    justify-content: center;
}
.shop-empty-category {
    grid-column: 1 / -1;
    padding: 2.5rem 1rem;
    text-align: center;
    color: var(--text-muted);
    background: var(--surface-secondary);
    border: 1px dashed var(--border-color);
    border-radius: 10px;
    font-size: .9rem;
}
.shop-empty {
    padding: 3.5rem 1rem;
    text-align: center;
    color: var(--text-muted);
    background: var(--card-bg);
    border: 1px dashed var(--border-color);
    border-radius: 12px;
}

/* Badges */
.badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.55rem;
    border-radius: 6px;
    font-size: 0.76rem;
    font-weight: 600;
    line-height: 1.2;
    border: 1px solid transparent;
}
.badge-success { background: var(--success-soft, #DCFCE7); color: #15803D; border-color: rgba(21, 128, 61, 0.15); }
.badge-warning { background: var(--warning-soft, #FEF3C7); color: #B45309; border-color: rgba(180, 83, 9, 0.15); }
.badge-danger  { background: var(--danger-soft, #FEE2E2);  color: #B91C1C; border-color: rgba(185, 28, 28, 0.15); }
.badge-secondary { background: var(--surface-2, #F5F6F8); color: var(--muted, #71757E); border-color: var(--border, #ECEDEF); }

/* Buttons */
.btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.55rem 0.95rem;
    font-size: 0.88rem;
    font-weight: 600;
    border-radius: 8px;
    border: 1px solid transparent;
    cursor: pointer;
    text-decoration: none;
    transition: all .15s ease;
}
.btn-primary {
    background: var(--accent, #7C3AED);
    color: #fff;
    border-color: var(--accent, #7C3AED);
}
.btn-primary:hover {
    background: var(--accent-deep, #6D28D9);
    border-color: var(--accent-deep, #6D28D9);
    color: #fff;
}
.btn-outline-secondary {
    background: transparent;
    color: var(--text-color);
    border-color: var(--border-color);
}
.btn-outline-secondary:hover {
    background: var(--surface-secondary);
    border-color: var(--border-strong-color);
    color: var(--text-color);
}
.btn-success {
    background: #059669;
    color: #fff;
    border-color: #059669;
}
.btn-success[disabled] {
    opacity: 0.88;
    cursor: default;
}

/* Modals with solid opaque background and backdrop blur */
.checkout-modal[hidden], .details-modal[hidden] {
    display: none !important;
}
.checkout-modal, .details-modal {
    position: fixed;
    inset: 0;
    z-index: 1050;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.25rem;
    background: rgba(15, 23, 42, 0.65);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
}
.checkout-dialog, .details-dialog {
    position: relative;
    background: #FFFFFF !important;
    background-color: #FFFFFF !important;
    color: var(--text-color, #16181D) !important;
    border: 1px solid var(--border-strong-color);
    border-radius: 14px;
    box-shadow: 0 25px 60px -15px rgba(0,0,0,0.4), 0 0 0 1px rgba(0,0,0,0.06);
    opacity: 1 !important;
}
.checkout-dialog {
    width: min(960px, 100%);
    height: min(760px, 92vh);
    overflow: hidden;
}
.details-dialog {
    width: min(600px, 100%);
    max-height: 90vh;
    overflow-y: auto;
}
.modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.1rem 1.3rem;
    border-bottom: 1px solid var(--border-color);
    background: #FFFFFF;
}
.modal-head strong {
    font-size: 1.15rem;
    font-weight: 700;
    color: var(--text-color, #16181D);
}
.modal-body {
    padding: 1.3rem;
    background: #FFFFFF;
    color: var(--text-color, #16181D);
}
.modal-close {
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font-size: 1.5rem;
    line-height: 1;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 6px;
    transition: background .15s, color .15s;
}
.modal-close:hover {
    background: rgba(0,0,0,0.05);
    color: var(--text-color);
}
.checkout-frame {
    width: 100%;
    height: calc(100% - 60px);
    border: 0;
    background: #fff;
}

/* Dark mode overrides for modal and cards */
@media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) .checkout-dialog,
    :root:not([data-theme="light"]) .details-dialog {
        background: #161e31 !important;
        background-color: #161e31 !important;
        color: #f1f5f9 !important;
        border-color: rgba(255, 255, 255, 0.12) !important;
    }
    :root:not([data-theme="light"]) .modal-head,
    :root:not([data-theme="light"]) .modal-body {
        background: #161e31 !important;
        color: #f1f5f9 !important;
    }
    :root:not([data-theme="light"]) .modal-head strong {
        color: #ffffff !important;
    }
    :root:not([data-theme="light"]) .modal-close:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #ffffff;
    }
}
:root[data-theme="dark"] .checkout-dialog,
:root[data-theme="dark"] .details-dialog,
html.dark .checkout-dialog,
html.dark .details-dialog,
body.dark .checkout-dialog,
body.dark .details-dialog {
    background: #161e31 !important;
    background-color: #161e31 !important;
    color: #f1f5f9 !important;
    border-color: rgba(255, 255, 255, 0.12) !important;
}
:root[data-theme="dark"] .modal-head,
:root[data-theme="dark"] .modal-body,
html.dark .modal-head,
html.dark .modal-body,
body.dark .modal-head,
body.dark .modal-body {
    background: #161e31 !important;
    color: #f1f5f9 !important;
}
:root[data-theme="dark"] .modal-head strong,
html.dark .modal-head strong,
body.dark .modal-head strong {
    color: #ffffff !important;
}
:root[data-theme="dark"] .modal-close:hover,
html.dark .modal-close:hover,
body.dark .modal-close:hover {
    background: rgba(255, 255, 255, 0.1) !important;
    color: #ffffff !important;
}
</style>

<div class="page-header">
    <div class="ph-content">
        <h1 class="page-title">Plugins Shop</h1>
        <div class="page-subtitle">Browse Slate plugins, manage active entitlements, or purchase add-ons</div>
    </div>
</div>

<div class="content-body">
    <div class="shop-toolbar" aria-label="Plugin filters">
        <input class="form-control" id="pluginSearch" type="search" placeholder="Search plugins..." aria-label="Search plugins">
        <select class="form-select" id="pluginCategory" aria-label="Filter by category">
            <option value="">All categories</option>
            <?php foreach (array_unique(array_column($catalog, 'category')) as $category): ?>
                <option value="<?= e(strtolower($category)) ?>"><?= e($category) ?></option>
            <?php endforeach; ?>
        </select>
        <select class="form-select" id="pluginSort" aria-label="Sort plugins">
            <option value="name">Sort: Name</option>
            <option value="price-low">Sort: Price low to high</option>
            <option value="price-high">Sort: Price high to low</option>
            <option value="category">Sort: Category</option>
        </select>
        <select class="form-select" id="billingCycle" aria-label="Billing cycle">
            <option value="monthly">Monthly</option>
            <option value="yearly" selected>Yearly</option>
            <option value="lifetime">Lifetime</option>
        </select>
    </div>

    <div class="shop-sections-container">
        <!-- 1. Activated / Included with License -->
        <section class="shop-section" id="activatedSection">
            <div class="shop-section-head">
                <div class="shop-section-title-wrap">
                    <h2 class="shop-section-title">
                        <span class="shop-section-icon shop-section-icon-active" aria-hidden="true">
                            <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>
                        </span>
                        Activated / Included with License
                    </h2>
                    <span class="badge badge-success shop-count-pill" id="activatedCount"><?= count($activatedPlugins) ?></span>
                </div>
                <p class="shop-section-desc">Plugins that are currently active, licensed, or included in your Slate package.</p>
            </div>

            <div class="shop-grid" id="activatedGrid">
                <?php foreach ($activatedPlugins as $plugin):
                    $payload = htmlspecialchars(json_encode([
                        'name' => $plugin['name'],
                        'version' => $plugin['version'],
                        'description' => $plugin['description'],
                        'category' => $plugin['category'],
                        'requires_core' => $plugin['requires_core'],
                        'features' => $plugin['features'],
                        'monthly' => $money($plugin['monthly_cents']),
                        'yearly' => $money($plugin['yearly_cents']),
                        'lifetime' => $money($plugin['lifetime_cents']),
                        'is_activated' => true,
                        'in_package' => $plugin['in_package'],
                        'package_slug' => $plugin['package_slug'],
                        'status' => $plugin['status'],
                        'purchase_monthly' => $plugin['purchase_monthly'],
                        'purchase_yearly' => $plugin['purchase_yearly'],
                        'purchase_lifetime' => $plugin['purchase_lifetime'],
                    ], JSON_HEX_TAG | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_HEX_AMP), ENT_QUOTES, 'UTF-8');
                ?>
                    <article class="shop-card" data-plugin-card data-group="activated" data-name="<?= e(strtolower($plugin['name'])) ?>" data-category="<?= e(strtolower($plugin['category'])) ?>" data-price="<?= e((string)$plugin['yearly_cents']) ?>">
                        <div class="shop-card-head">
                            <h2 class="shop-card-title">
                                <span><?= e($plugin['name']) ?></span>
                                <span class="badge badge-secondary">v<?= e($plugin['version']) ?></span>
                            </h2>
                            <div class="shop-meta">
                                <span class="badge badge-secondary"><?= e($plugin['category']) ?></span>
                                <?php if ($plugin['in_package']): ?>
                                    <span class="badge badge-success">Included in <?= e($plugin['package_slug'] ?: 'Package') ?></span>
                                <?php elseif ($plugin['active']): ?>
                                    <span class="badge badge-success">Activated</span>
                                <?php else: ?>
                                    <span class="badge badge-<?= e($statusClass($plugin['status'])) ?>"><?= e(ucfirst($plugin['status'])) ?></span>
                                <?php endif; ?>
                            </div>
                        </div>
                        <div class="shop-card-body">
                            <div class="shop-tagline"><?= e($plugin['tagline']) ?></div>
                            <?php if ($plugin['features']): ?>
                                <ul class="shop-features">
                                    <?php foreach (array_slice($plugin['features'], 0, 3) as $feature): ?><li><?= e($feature) ?></li><?php endforeach; ?>
                                </ul>
                            <?php endif; ?>
                            <div class="shop-price shop-price-owned">
                                <span>✓ <?= $plugin['in_package'] ? 'Included with License' : 'Active & Licensed' ?></span>
                            </div>
                        </div>
                        <div class="shop-card-actions">
                            <button class="btn btn-outline-secondary" type="button" data-details='<?= $payload ?>'>View details</button>
                            <?php if ($plugin['in_package']): ?>
                                <button class="btn btn-success" type="button" disabled>Included</button>
                            <?php else: ?>
                                <button class="btn btn-success" type="button" disabled>Activated</button>
                            <?php endif; ?>
                        </div>
                    </article>
                <?php endforeach; ?>
                <div class="shop-empty-category" id="activatedEmpty" <?= count($activatedPlugins) > 0 ? 'hidden' : '' ?>>
                    No activated plugins match your selection.
                </div>
            </div>
        </section>

        <!-- 2. Available Plugins / Not Installed Yet -->
        <section class="shop-section" id="availableSection">
            <div class="shop-section-head">
                <div class="shop-section-title-wrap">
                    <h2 class="shop-section-title">
                        <span class="shop-section-icon shop-section-icon-available" aria-hidden="true">
                            <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path d="M3 1a1 1 0 000 2h1.22l.305 1.222a.997.997 0 00.01.042l1.358 5.43-.893.892C3.74 11.846 4.632 14 6.414 14H15a1 1 0 000-2H6.414l1-1H14a1 1 0 00.894-.553l3-6A1 1 0 0017 3H6.28l-.2-1a1 1 0 00-.98-.8H3zM16 16.5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zM6.5 18a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"/></svg>
                        </span>
                        Available Plugins / Not Installed Yet
                    </h2>
                    <span class="badge badge-secondary shop-count-pill" id="availableCount"><?= count($availablePlugins) ?></span>
                </div>
                <p class="shop-section-desc">Add modular add-ons and premium tools to enhance your Slate workflow.</p>
            </div>

            <div class="shop-grid" id="availableGrid">
                <?php foreach ($availablePlugins as $plugin):
                    $payload = htmlspecialchars(json_encode([
                        'name' => $plugin['name'],
                        'version' => $plugin['version'],
                        'description' => $plugin['description'],
                        'category' => $plugin['category'],
                        'requires_core' => $plugin['requires_core'],
                        'features' => $plugin['features'],
                        'monthly' => $money($plugin['monthly_cents']),
                        'yearly' => $money($plugin['yearly_cents']),
                        'lifetime' => $money($plugin['lifetime_cents']),
                        'is_activated' => false,
                        'in_package' => false,
                        'package_slug' => '',
                        'status' => $plugin['status'],
                        'purchase_monthly' => $plugin['purchase_monthly'],
                        'purchase_yearly' => $plugin['purchase_yearly'],
                        'purchase_lifetime' => $plugin['purchase_lifetime'],
                    ], JSON_HEX_TAG | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_HEX_AMP), ENT_QUOTES, 'UTF-8');
                ?>
                    <article class="shop-card" data-plugin-card data-group="available" data-name="<?= e(strtolower($plugin['name'])) ?>" data-category="<?= e(strtolower($plugin['category'])) ?>" data-price="<?= e((string)$plugin['yearly_cents']) ?>">
                        <div class="shop-card-head">
                            <h2 class="shop-card-title">
                                <span><?= e($plugin['name']) ?></span>
                                <span class="badge badge-secondary">v<?= e($plugin['version']) ?></span>
                            </h2>
                            <div class="shop-meta">
                                <span class="badge badge-secondary"><?= e($plugin['category']) ?></span>
                                <span class="badge badge-secondary">Not Installed</span>
                            </div>
                        </div>
                        <div class="shop-card-body">
                            <div class="shop-tagline"><?= e($plugin['tagline']) ?></div>
                            <?php if ($plugin['features']): ?>
                                <ul class="shop-features">
                                    <?php foreach (array_slice($plugin['features'], 0, 3) as $feature): ?><li><?= e($feature) ?></li><?php endforeach; ?>
                                </ul>
                            <?php endif; ?>
                            <div class="shop-price" data-price-monthly="<?= e($money($plugin['monthly_cents'])) ?>" data-price-yearly="<?= e($money($plugin['yearly_cents'])) ?>" data-price-lifetime="<?= e($money($plugin['lifetime_cents'])) ?>">
                                <?= e($money($plugin['yearly_cents'])) ?> <small>/ year</small>
                            </div>
                        </div>
                        <div class="shop-card-actions">
                            <button class="btn btn-outline-secondary" type="button" data-details='<?= $payload ?>'>View details</button>
                            <button class="btn btn-primary" type="button" data-purchase-monthly="<?= e($plugin['purchase_monthly']) ?>" data-purchase-yearly="<?= e($plugin['purchase_yearly']) ?>" data-purchase-lifetime="<?= e($plugin['purchase_lifetime']) ?>">Buy Now</button>
                        </div>
                    </article>
                <?php endforeach; ?>
                <div class="shop-empty-category" id="availableEmpty" <?= count($availablePlugins) > 0 ? 'hidden' : '' ?>>
                    No available plugins match your selection.
                </div>
            </div>
        </section>

        <div class="shop-empty" id="pluginEmpty" hidden>
            <h3 style="margin-top:0;margin-bottom:0.5rem;font-size:1.15rem;">No plugins found</h3>
            <p style="margin:0;color:var(--text-muted);">No plugins match your search query or selected category filter.</p>
        </div>
    </div>
</div>

<!-- Details Modal -->
<div class="details-modal" id="detailsModal" hidden role="dialog" aria-modal="true" aria-labelledby="detailsTitle">
    <div class="details-dialog">
        <div class="modal-head">
            <strong id="detailsTitle">Plugin details</strong>
            <button class="modal-close" type="button" data-close-details aria-label="Close">&times;</button>
        </div>
        <div class="modal-body" id="detailsBody"></div>
    </div>
</div>

<!-- Checkout Modal -->
<div class="checkout-modal" id="checkoutModal" hidden role="dialog" aria-modal="true" aria-labelledby="checkoutTitle">
    <div class="checkout-dialog">
        <div class="modal-head">
            <strong id="checkoutTitle">Checkout</strong>
            <button class="modal-close" type="button" data-close-checkout aria-label="Close">&times;</button>
        </div>
        <iframe class="checkout-frame" id="checkoutFrame" title="Secure checkout" src="about:blank"></iframe>
    </div>
</div>

<script>
(() => {
    const activatedGrid = document.getElementById('activatedGrid');
    const availableGrid = document.getElementById('availableGrid');
    const activatedCards = [...document.querySelectorAll('#activatedGrid [data-plugin-card]')];
    const availableCards = [...document.querySelectorAll('#availableGrid [data-plugin-card]')];
    const search = document.getElementById('pluginSearch');
    const category = document.getElementById('pluginCategory');
    const sort = document.getElementById('pluginSort');
    const cycle = document.getElementById('billingCycle');
    const activatedEmpty = document.getElementById('activatedEmpty');
    const availableEmpty = document.getElementById('availableEmpty');
    const activatedCount = document.getElementById('activatedCount');
    const availableCount = document.getElementById('availableCount');
    const pluginEmpty = document.getElementById('pluginEmpty');
    const checkout = document.getElementById('checkoutModal');
    const frame = document.getElementById('checkoutFrame');
    const checkoutTitle = document.getElementById('checkoutTitle');
    const details = document.getElementById('detailsModal');
    const detailsTitle = document.getElementById('detailsTitle');
    const detailsBody = document.getElementById('detailsBody');

    let frameOrigin = '';
    const closeCheckout = () => { checkout.hidden = true; frame.src = 'about:blank'; frameOrigin = ''; };
    const closeDetails = () => { details.hidden = true; };
    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));

    const openCheckoutUrl = (url) => {
        if (!url || url === '#token-error') { window.alert('A secure checkout token could not be created.'); return; }
        if (url === '#master-unavailable') { window.alert('The licensing Master is not configured for this site.'); return; }
        if (url === '#invalid-product') { window.alert('This plugin is not available for purchase.'); return; }
        let parsed;
        try { parsed = new URL(url, window.location.href); } catch { window.alert('Checkout URL is invalid.'); return; }
        if (!['http:', 'https:'].includes(parsed.protocol)) { window.alert('Checkout URL is invalid.'); return; }
        frameOrigin = parsed.origin;
        checkoutTitle.textContent = 'Purchase plugin';
        frame.src = url;
        checkout.hidden = false;
    };

    const openCheckoutFromButton = (button) => {
        const url = button.dataset['purchase' + cycle.value.charAt(0).toUpperCase() + cycle.value.slice(1)] || '#token-error';
        openCheckoutUrl(url);
    };

    const renderDetails = (button) => {
        let data;
        try { data = JSON.parse(button.dataset.details); } catch { return; }
        const features = (data.features || []).map((f) => '<li>' + escapeHtml(f) + '</li>').join('');
        const statusBadge = data.is_activated
            ? '<span class="badge badge-success" style="font-size:0.85rem;padding:4px 8px;">✓ ' + escapeHtml(data.in_package ? 'Included with License' : 'Activated') + '</span>'
            : '<span class="badge badge-secondary" style="font-size:0.85rem;padding:4px 8px;">Not Installed</span>';

        let priceSection = '';
        if (data.is_activated) {
            priceSection = '<div style="margin-top:1.25rem;padding:0.9rem 1rem;border-radius:8px;background:var(--surface-secondary,#f5f6f8);border:1px solid var(--border-color);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;">'
                + '<div><strong style="color:var(--text-color);">License Status:</strong> ' + (data.in_package ? 'Included with package (' + escapeHtml(data.package_slug || 'Slate') + ')' : 'Activated on this instance') + '</div>'
                + '<div>' + statusBadge + '</div>'
                + '</div>';
        } else {
            priceSection = '<div style="margin-top:1.25rem;padding:1rem;border-radius:8px;background:var(--surface-secondary,#f5f6f8);border:1px solid var(--border-color);">'
                + '<div style="font-weight:650;margin-bottom:0.5rem;color:var(--text-color);">Pricing Options:</div>'
                + '<div style="display:flex;gap:1.25rem;flex-wrap:wrap;font-size:0.92rem;margin-bottom:1rem;">'
                + '<span><strong>Monthly:</strong> ' + escapeHtml(data.monthly) + '</span>'
                + '<span><strong>Yearly:</strong> ' + escapeHtml(data.yearly) + '</span>'
                + '<span><strong>Lifetime:</strong> ' + escapeHtml(data.lifetime) + '</span>'
                + '</div>'
                + '<div style="display:flex;justify-content:flex-end;">'
                + '<button class="btn btn-primary" type="button" id="modalBuyNowBtn">Buy Now</button>'
                + '</div>'
                + '</div>';
        }

        detailsTitle.textContent = data.name;
        detailsBody.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;gap:0.5rem;flex-wrap:wrap;">'
            + '<h2 style="margin:0;font-size:1.35rem;font-weight:700;color:var(--text-color);">' + escapeHtml(data.name) + ' <span class="badge badge-secondary" style="font-size:0.75rem;vertical-align:middle;">v' + escapeHtml(data.version) + '</span></h2>'
            + statusBadge
            + '</div>'
            + '<p style="color:var(--text-muted);margin:0.5rem 0 1rem;font-size:0.95rem;line-height:1.55;">' + escapeHtml(data.description || data.tagline) + '</p>'
            + '<div style="display:flex;gap:1.5rem;margin-bottom:1rem;font-size:0.88rem;color:var(--text-muted);flex-wrap:wrap;">'
            + '<div><strong style="color:var(--text-color);">Category:</strong> ' + escapeHtml(data.category) + '</div>'
            + (data.requires_core ? '<div><strong style="color:var(--text-color);">Requires:</strong> Slate ' + escapeHtml(data.requires_core) + '</div>' : '')
            + '</div>'
            + (features ? '<h3 style="font-size:1rem;font-weight:650;margin:1rem 0 0.5rem;color:var(--text-color);">Key Features</h3><ul class="shop-features" style="margin-bottom:1rem;">' + features + '</ul>' : '')
            + priceSection;

        const buyBtn = document.getElementById('modalBuyNowBtn');
        if (buyBtn) {
            buyBtn.addEventListener('click', () => {
                closeDetails();
                const cycleKey = 'purchase_' + cycle.value;
                const buyUrl = data[cycleKey] || data.purchase_yearly || data.purchase_monthly;
                openCheckoutUrl(buyUrl);
            });
        }

        details.hidden = false;
    };

    const sortCards = (cardsList) => {
        return cardsList.slice().sort((a, b) => {
            if (sort.value === 'price-low' || sort.value === 'price-high') {
                const diff = Number(a.dataset.price || 0) - Number(b.dataset.price || 0);
                return sort.value === 'price-low' ? diff : -diff;
            }
            if (sort.value === 'category') {
                return (a.dataset.category || '').localeCompare(b.dataset.category || '') || (a.dataset.name || '').localeCompare(b.dataset.name || '');
            }
            return (a.dataset.name || '').localeCompare(b.dataset.name || '');
        });
    };

    const filterCards = (cardsList, grid, emptyEl, countEl) => {
        const q = search.value.trim().toLowerCase();
        const cat = category.value;
        const visible = cardsList.filter((card) => {
            const match = (!q || card.dataset.name.includes(q) || card.textContent.toLowerCase().includes(q))
                       && (!cat || card.dataset.category === cat);
            card.hidden = !match;
            return match;
        });

        const sorted = sortCards(visible);
        sorted.forEach((card) => grid.appendChild(card));
        grid.appendChild(emptyEl);
        emptyEl.hidden = visible.length !== 0;
        if (countEl) countEl.textContent = visible.length;
        return visible.length;
    };

    const refresh = () => {
        const actCount = filterCards(activatedCards, activatedGrid, activatedEmpty, activatedCount);
        const avlCount = filterCards(availableCards, availableGrid, availableEmpty, availableCount);
        const total = actCount + avlCount;

        if (pluginEmpty) {
            pluginEmpty.hidden = total !== 0;
        }

        document.querySelectorAll('[data-price-monthly]').forEach((price) => {
            const cycleKey = 'price' + cycle.value.charAt(0).toUpperCase() + cycle.value.slice(1);
            const value = price.dataset[cycleKey];
            if (value) {
                price.innerHTML = value + ' <small>/ ' + cycle.value.replace('lifetime', 'once') + '</small>';
            }
        });
    };

    [search, category, sort, cycle].forEach((el) => el.addEventListener('input', refresh));
    document.querySelectorAll('[data-details]').forEach((button) => button.addEventListener('click', () => renderDetails(button)));
    document.querySelectorAll('[data-purchase-monthly]').forEach((button) => button.addEventListener('click', () => openCheckoutFromButton(button)));
    document.querySelector('[data-close-checkout]')?.addEventListener('click', closeCheckout);
    document.querySelector('[data-close-details]')?.addEventListener('click', closeDetails);
    checkout.addEventListener('click', (event) => { if (event.target === checkout) closeCheckout(); });
    details.addEventListener('click', (event) => { if (event.target === details) closeDetails(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { closeCheckout(); closeDetails(); } });
    window.addEventListener('message', (event) => {
        if (checkout.hidden || event.source !== frame.contentWindow || !frameOrigin || event.origin !== frameOrigin) return;
        const message = event.data || {};
        if (message.version !== 1) return;
        if (message.type === 'slate.checkout.completed') { closeCheckout(); window.location.reload(); }
        else if (message.type === 'slate.checkout.cancelled') closeCheckout();
        else if (message.type === 'slate.checkout.failed') { closeCheckout(); window.alert('Checkout failed. Please try again.'); }
    });

    refresh();
})();
</script>

<?php require __DIR__ . '/partials/footer.php'; ?>
