<?php
require_once __DIR__ . '/../includes/bootstrap.php';
require_once __DIR__ . '/../includes/shop_client.php';
use Slate\Kernel\Module\PluginLoader;

Auth::requirePerm('plugins.manage');

$currentNav = 'plugins-shop';
$pageTitle = 'Plugins Shop';

// Get current package slug
$packageSlug = '';
try {
    $packageSlug = getenv('SLATE_PACKAGE_SLUG') ?: '';
    if (!$packageSlug && is_file(__DIR__.'/../../.slate_agent_config.json')) {
        $cfg = json_decode(file_get_contents(__DIR__.'/../../.slate_agent_config.json'), true);
        $packageSlug = $cfg['package_slug'] ?? '';
    }
} catch (\Throwable $e) {}

// For now, load catalog by scanning local plugin.json
// In a full implementation, we could fetch from Master API to get live prices
$catalog = [];
$pluginsDir = __DIR__ . '/../plugins';
if (is_dir($pluginsDir)) {
    foreach (scandir($pluginsDir) as $d) {
        if ($d === '.' || $d === '..') continue;
        $jsonFile = $pluginsDir . '/' . $d . '/plugin.json';
        if (is_file($jsonFile)) {
            $manifest = json_decode(file_get_contents($jsonFile), true);
            if (!empty($manifest['licensable'])) {
                $catalog[] = $manifest;
            }
        }
    }
}

// Get active plugin licenses to show owned state
$ownedSlugs = [];
try {
    $rows = Database::rows("SELECT plugin_slug, status FROM plugin_licenses WHERE status = 'active'");
    foreach ($rows as $r) {
        $ownedSlugs[$r['plugin_slug']] = true;
    }
} catch (\Throwable $e) {}

require __DIR__ . '/partials/header.php';
?>

<style>
.plugin-card { display: flex; flex-direction: column; height: 100%; border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden; background: var(--card-bg); transition: transform 0.2s, box-shadow 0.2s; }
.plugin-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
.plugin-header { padding: 1.25rem; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: flex-start; }
.plugin-title { font-weight: 600; font-size: 1.1rem; margin: 0; color: var(--text-color); }
.plugin-tagline { color: var(--text-muted); font-size: 0.85rem; margin-top: 0.25rem; }
.plugin-body { padding: 1.25rem; flex-grow: 1; display: flex; flex-direction: column; }
.plugin-features { list-style: none; padding: 0; margin: 0 0 1rem 0; font-size: 0.9rem; }
.plugin-features li { position: relative; padding-left: 1.25rem; margin-bottom: 0.25rem; color: var(--text-color); }
.plugin-features li::before { content: "✓"; position: absolute; left: 0; color: var(--success); font-weight: bold; }
.plugin-price { margin-top: auto; font-size: 1.25rem; font-weight: bold; color: var(--primary); }
.plugin-price small { font-size: 0.8rem; font-weight: normal; color: var(--text-muted); }
.plugin-footer { padding: 1rem 1.25rem; background: var(--bg-body); border-top: 1px solid var(--border-color); display: flex; gap: 0.5rem; }
</style>

<div class="page-header">
    <div class="ph-content">
        <h1 class="page-title">Plugins Shop</h1>
        <div class="page-subtitle">Enhance your platform with premium add-ons</div>
    </div>
</div>

<div class="content-body">
    <div class="row row-cols-1 row-cols-md-2 row-cols-lg-3 g-4">
        <?php foreach ($catalog as $p): 
            $price = $p['price'] ?? null;
            $shop = $p['shop'] ?? [];
            $monthly = $price ? number_format(($price['monthly_cents'] ?? 0) / 100, 2) : '0.00';
            $isOwned = isset($ownedSlugs[$p['slug']]);
            // If the plugin is already loaded, we assume it's part of the package or explicitly active
            $isActive = PluginLoader::isActive($p['slug']);
        ?>
        <div class="col">
            <div class="plugin-card">
                <div class="plugin-header">
                    <div>
                        <h3 class="plugin-title"><?= e($p['name']) ?> <span class="badge badge-secondary" style="font-size: 0.7em">v<?= e($p['version']) ?></span></h3>
                        <div class="plugin-tagline"><?= e($shop['tagline'] ?? $p['description']) ?></div>
                    </div>
                </div>
                
                <div class="plugin-body">
                    <?php if (!empty($shop['features'])): ?>
                    <ul class="plugin-features">
                        <?php foreach ($shop['features'] as $f): ?>
                            <li><?= e($f) ?></li>
                        <?php endforeach; ?>
                    </ul>
                    <?php endif; ?>
                    
                    <div class="plugin-price">
                        $<?= $monthly ?> <small>/ mo</small>
                    </div>
                </div>
                
                <div class="plugin-footer">
                    <?php if ($isOwned || $isActive): ?>
                        <button class="btn btn-success w-100" disabled>
                            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="20 6 9 17 4 12"></polyline></svg>
                            Owned & Active
                        </button>
                    <?php else: ?>
                        <button class="btn btn-primary flex-grow-1" onclick="buyPlugin('<?= e($p['slug']) ?>')">Purchase</button>
                    <?php endif; ?>
                </div>
            </div>
        </div>
        <?php endforeach; ?>
    </div>
</div>

<script>
function buyPlugin(slug) {
    // In full implementation, this opens an iframe to Master dashboard
    // using a minted TenantToken.
    const w = 600, h = 800;
    const x = (screen.width - w) / 2;
    const y = (screen.height - h) / 2;
    window.open(
        "<?= e(SLATE_URL) ?>/admin/checkout-modal.php?plugin=" + encodeURIComponent(slug),
        "Checkout",
        `width=${w},height=${h},left=${x},top=${y}`
    );
}
</script>

<?php require __DIR__ . '/partials/footer.php'; ?>
