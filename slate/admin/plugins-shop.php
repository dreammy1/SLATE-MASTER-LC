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
            'in_package' => $source === 'package',
            'purchase_monthly' => shop_checkout_url($slug, 'monthly'),
            'purchase_yearly' => shop_checkout_url($slug, 'yearly'),
            'purchase_lifetime' => shop_checkout_url($slug, 'lifetime'),
        ];
    }
}
usort($catalog, static function (array $a, array $b): int {
    return strcasecmp($a['category'] . $a['name'], $b['category'] . $b['name']);
});

$money = static function (int $cents): string {
    return $cents > 0 ? '$' . number_format($cents / 100, 2) : '—';
};
$statusClass = static function (string $status): string {
    return match ($status) {
        'active', 'trial' => 'success',
        'expiring' => 'warning',
        'expired' => 'warning',
        'blocked', 'suspended', 'revoked', 'cancelled' => 'danger',
        default => 'secondary',
    };
};

require __DIR__ . '/partials/header.php';
?>

<style>
.shop-toolbar { display:flex; flex-wrap:wrap; gap:.75rem; align-items:center; margin-bottom:1.25rem; }
.shop-toolbar .form-control, .shop-toolbar .form-select { min-width:180px; flex:1 1 180px; }
.shop-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(270px,1fr)); gap:1rem; }
.shop-card { display:flex; flex-direction:column; min-height:300px; border:1px solid var(--border-color); border-radius:10px; background:var(--card-bg); overflow:hidden; transition:transform .15s,box-shadow .15s; }
.shop-card:hover { transform:translateY(-2px); box-shadow:0 8px 24px rgba(0,0,0,.08); }
.shop-card-head { padding:1rem 1.1rem .8rem; border-bottom:1px solid var(--border-color); }
.shop-card-body { display:flex; flex:1; flex-direction:column; padding:1rem 1.1rem; }
.shop-card-title { margin:0; font-size:1.05rem; font-weight:650; color:var(--text-color); }
.shop-meta { display:flex; flex-wrap:wrap; gap:.4rem; margin-top:.45rem; }
.shop-tagline { min-height:2.5rem; margin:.65rem 0; color:var(--text-muted); font-size:.9rem; }
.shop-features { margin:0 0 1rem; padding-left:1.1rem; color:var(--text-color); font-size:.86rem; }
.shop-price { margin-top:auto; color:var(--primary); font-size:1.05rem; font-weight:650; }
.shop-price small { color:var(--text-muted); font-weight:400; }
.shop-card-actions { display:flex; gap:.5rem; padding:1rem 1.1rem; border-top:1px solid var(--border-color); }
.shop-card-actions .btn { flex:1; }
.shop-empty { grid-column:1/-1; padding:3rem 1rem; text-align:center; color:var(--text-muted); }
.checkout-modal[hidden], .details-modal[hidden] { display:none; }
.checkout-modal, .details-modal { position:fixed; inset:0; z-index:1050; display:flex; align-items:center; justify-content:center; padding:1rem; background:rgba(15,23,42,.62); }
.checkout-dialog { width:min(960px,100%); height:min(760px,92vh); overflow:hidden; border-radius:14px; background:var(--card-bg); box-shadow:0 20px 70px rgba(0,0,0,.25); }
.details-dialog { width:min(600px,100%); max-height:90vh; overflow:auto; border-radius:14px; background:var(--card-bg); box-shadow:0 20px 70px rgba(0,0,0,.25); }
.modal-head { display:flex; align-items:center; justify-content:space-between; padding:1rem 1.1rem; border-bottom:1px solid var(--border-color); }
.modal-body { padding:1.1rem; }
.modal-close { border:0; background:transparent; color:var(--text-muted); font-size:1.35rem; cursor:pointer; }
.checkout-frame { width:100%; height:calc(100% - 58px); border:0; background:#fff; }
</style>

<div class="page-header">
    <div class="ph-content">
        <h1 class="page-title">Plugins Shop</h1>
        <div class="page-subtitle">Browse individual Slate add-ons and see what your package already includes</div>
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

    <div class="shop-grid" id="pluginGrid">
        <?php foreach ($catalog as $plugin):
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
            ], JSON_HEX_TAG | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_HEX_AMP), ENT_QUOTES, 'UTF-8');
        ?>
            <article class="shop-card" data-plugin-card data-name="<?= e(strtolower($plugin['name'])) ?>" data-category="<?= e(strtolower($plugin['category'])) ?>" data-price="<?= e((string)$plugin['yearly_cents']) ?>">
                <div class="shop-card-head">
                    <h2 class="shop-card-title"><?= e($plugin['name']) ?> <span class="badge badge-secondary">v<?= e($plugin['version']) ?></span></h2>
                    <div class="shop-meta">
                        <span class="badge badge-secondary"><?= e($plugin['category']) ?></span>
                        <?php if ($plugin['in_package']): ?>
                            <span class="badge badge-success">Included in <?= e($plugin['package_slug'] ?: 'package') ?></span>
                        <?php elseif ($plugin['status'] !== 'unowned'): ?>
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
                    <div class="shop-price" data-price-monthly="<?= e($money($plugin['monthly_cents'])) ?>" data-price-yearly="<?= e($money($plugin['yearly_cents'])) ?>" data-price-lifetime="<?= e($money($plugin['lifetime_cents'])) ?>">
                        <?= e($money($plugin['yearly_cents'])) ?> <small>/ year</small>
                    </div>
                </div>
                <div class="shop-card-actions">
                    <button class="btn btn-outline-secondary" type="button" data-details='<?= $payload ?>'>View details</button>
                    <?php if ($plugin['in_package']): ?>
                        <button class="btn btn-success" type="button" disabled>Included</button>
                    <?php elseif ($plugin['status'] === 'active' || $plugin['status'] === 'trial' || $plugin['active']): ?>
                        <button class="btn btn-success" type="button" disabled>Active</button>
                    <?php else: ?>
                        <button class="btn btn-primary" type="button" data-purchase-monthly="<?= e($plugin['purchase_monthly']) ?>" data-purchase-yearly="<?= e($plugin['purchase_yearly']) ?>" data-purchase-lifetime="<?= e($plugin['purchase_lifetime']) ?>">Purchase now</button>
                    <?php endif; ?>
                </div>
            </article>
        <?php endforeach; ?>
        <div class="shop-empty" id="pluginEmpty" hidden>No plugins match your filters.</div>
    </div>
</div>

<div class="details-modal" id="detailsModal" hidden role="dialog" aria-modal="true" aria-labelledby="detailsTitle">
    <div class="details-dialog">
        <div class="modal-head"><strong id="detailsTitle">Plugin details</strong><button class="modal-close" type="button" data-close-details aria-label="Close">&times;</button></div>
        <div class="modal-body" id="detailsBody"></div>
    </div>
</div>

<div class="checkout-modal" id="checkoutModal" hidden role="dialog" aria-modal="true" aria-labelledby="checkoutTitle">
    <div class="checkout-dialog">
        <div class="modal-head"><strong id="checkoutTitle">Checkout</strong><button class="modal-close" type="button" data-close-checkout aria-label="Close">&times;</button></div>
        <iframe class="checkout-frame" id="checkoutFrame" title="Secure checkout" src="about:blank"></iframe>
    </div>
</div>

<script>
(() => {
    const grid = document.getElementById('pluginGrid');
    const cards = [...document.querySelectorAll('[data-plugin-card]')];
    const search = document.getElementById('pluginSearch');
    const category = document.getElementById('pluginCategory');
    const sort = document.getElementById('pluginSort');
    const cycle = document.getElementById('billingCycle');
    const empty = document.getElementById('pluginEmpty');
    const checkout = document.getElementById('checkoutModal');
    const frame = document.getElementById('checkoutFrame');
    const checkoutTitle = document.getElementById('checkoutTitle');
    const details = document.getElementById('detailsModal');
    const detailsBody = document.getElementById('detailsBody');

    const closeCheckout = () => { checkout.hidden = true; frame.src = 'about:blank'; };
    const closeDetails = () => { details.hidden = true; };
    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
    const openCheckout = (button) => {
        const url = button.dataset['purchase' + cycle.value.charAt(0).toUpperCase() + cycle.value.slice(1)] || '#token-error';
        if (url === '#token-error') { window.alert('Checkout is not configured for this site yet.'); return; }
        checkoutTitle.textContent = 'Purchase plugin';
        frame.src = url;
        checkout.hidden = false;
    };
    const renderDetails = (button) => {
        let data;
        try { data = JSON.parse(button.dataset.details); } catch { return; }
        const features = (data.features || []).map((f) => '<li>' + escapeHtml(f) + '</li>').join('');
        detailsBody.innerHTML = '<h2>' + escapeHtml(data.name) + '</h2>'
            + '<p class="text-muted">' + escapeHtml(data.description) + '</p>'
            + '<p><strong>Category:</strong> ' + escapeHtml(data.category) + ' &nbsp; <strong>Version:</strong> ' + escapeHtml(data.version) + '</p>'
            + (data.requires_core ? '<p><strong>Requires:</strong> Slate ' + escapeHtml(data.requires_core) + '</p>' : '')
            + (features ? '<h3>Features</h3><ul>' + features + '</ul>' : '')
            + '<hr><p><strong>Monthly:</strong> ' + escapeHtml(data.monthly) + ' &nbsp; <strong>Yearly:</strong> ' + escapeHtml(data.yearly) + ' &nbsp; <strong>Lifetime:</strong> ' + escapeHtml(data.lifetime) + '</p>';
        details.hidden = false;
    };
    const refresh = () => {
        const q = search.value.trim().toLowerCase();
        const cat = category.value;
        const visible = cards.filter((card) => {
            const match = (!q || card.dataset.name.includes(q) || card.textContent.toLowerCase().includes(q)) && (!cat || card.dataset.category === cat);
            card.hidden = !match;
            return match;
        });
        visible.sort((a, b) => {
            if (sort.value === 'price-low' || sort.value === 'price-high') {
                const diff = Number(a.dataset.price) - Number(b.dataset.price);
                return sort.value === 'price-low' ? diff : -diff;
            }
            if (sort.value === 'category') return a.dataset.category.localeCompare(b.dataset.category) || a.dataset.name.localeCompare(b.dataset.name);
            return a.dataset.name.localeCompare(b.dataset.name);
        }).forEach((card) => grid.appendChild(card));
        grid.appendChild(empty);
        empty.hidden = visible.length !== 0;
        document.querySelectorAll('[data-price-monthly]').forEach((price) => {
            const value = price.dataset['price' + cycle.value.charAt(0).toUpperCase() + cycle.value.slice(1)];
            price.innerHTML = value + ' <small>/ ' + cycle.value.replace('lifetime', 'once') + '</small>';
        });
    };
    [search, category, sort, cycle].forEach((el) => el.addEventListener('input', refresh));
    document.querySelectorAll('[data-details]').forEach((button) => button.addEventListener('click', () => renderDetails(button)));
    document.querySelectorAll('[data-purchase-monthly]').forEach((button) => button.addEventListener('click', () => openCheckout(button)));
    document.querySelector('[data-close-checkout]')?.addEventListener('click', closeCheckout);
    document.querySelector('[data-close-details]')?.addEventListener('click', closeDetails);
    checkout.addEventListener('click', (event) => { if (event.target === checkout) closeCheckout(); });
    details.addEventListener('click', (event) => { if (event.target === details) closeDetails(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { closeCheckout(); closeDetails(); } });
    refresh();
})();
</script>

<?php require __DIR__ . '/partials/footer.php'; ?>
