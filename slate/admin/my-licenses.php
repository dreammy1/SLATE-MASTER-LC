<?php
require_once __DIR__ . '/../includes/bootstrap.php';
require_once __DIR__ . '/../includes/shop_client.php';

Auth::requirePerm('settings.view');

$currentNav = 'my-licenses';
$pageTitle = 'My Licenses';

// In a real app we'd fetch from PluginEntitlement or DB
$pluginLicenses = [];
try {
    $pluginLicenses = Database::rows("SELECT * FROM plugin_licenses ORDER BY created_at DESC");
} catch (\Throwable $e) {}

$coreLicense = null;
try {
    $coreLicense = Database::row("SELECT * FROM licenses ORDER BY id DESC LIMIT 1");
} catch (\Throwable $e) {}

// For package badge lookup
$packageSlug = '';
try {
    $packageSlug = getenv('SLATE_PACKAGE_SLUG') ?: '';
    if (!$packageSlug && is_file(__DIR__.'/../../.slate_agent_config.json')) {
        $cfg = json_decode(file_get_contents(__DIR__.'/../../.slate_agent_config.json'), true);
        $packageSlug = $cfg['package_slug'] ?? '';
    }
} catch (\Throwable $e) {}

require __DIR__ . '/partials/header.php';
?>

<div class="page-header">
    <div class="ph-content">
        <h1 class="page-title">My Licenses</h1>
        <div class="page-subtitle">Manage your core platform and plugin entitlements</div>
    </div>
</div>

<div class="content-body">
    <div class="card">
        <div class="table-responsive">
            <table class="table">
                <thead>
                    <tr>
                        <th>Product</th>
                        <th>Type</th>
                        <th>Status</th>
                        <th>Activated</th>
                        <th>Expires</th>
                        <th>Key</th>
                        <th class="text-end">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    <?php if ($coreLicense): ?>
                    <tr>
                        <td><strong>Slate Core</strong><br><small class="text-muted"><?= e(ucwords(str_replace('-', ' ', $packageSlug ?: 'Core'))) ?></small></td>
                        <td>Core License</td>
                        <td>
                            <span class="badge badge-<?= $coreLicense['status'] === 'active' ? 'success' : 'warning' ?>">
                                <?= e(ucfirst($coreLicense['status'])) ?>
                            </span>
                        </td>
                        <td><?= e(date('M j, Y', strtotime($coreLicense['starts_at']))) ?></td>
                        <td><?= $coreLicense['expires_at'] ? e(date('M j, Y', strtotime($coreLicense['expires_at']))) : 'Lifetime' ?></td>
                        <td>
                            <code class="text-muted">SLT-****-****-<?= e(substr($coreLicense['key_hash'] ?? '0000', -4)) ?></code>
                        </td>
                        <td class="text-end">
                            <button class="btn btn-sm btn-outline-primary" onclick="alert('Please renew via Master Dashboard.')">Renew</button>
                        </td>
                    </tr>
                    <?php endif; ?>

                    <?php foreach ($pluginLicenses as $lic): 
                        $meta = json_decode($lic['metadata'] ?? '{}', true);
                    ?>
                    <tr>
                        <td><strong><?= e($meta['name'] ?? ucfirst($lic['plugin_slug'])) ?></strong></td>
                        <td>Plugin License</td>
                        <td>
                            <span class="badge badge-<?= $lic['status'] === 'active' ? 'success' : 'warning' ?>">
                                <?= e(ucfirst($lic['status'])) ?>
                            </span>
                        </td>
                        <td><?= e(date('M j, Y', strtotime($lic['starts_at']))) ?></td>
                        <td><?= $lic['expires_at'] ? e(date('M j, Y', strtotime($lic['expires_at']))) : 'Lifetime' ?></td>
                        <td>
                            <code class="text-muted">PLG-****-****-<?= e($lic['license_key_last4'] ?? '0000') ?></code>
                        </td>
                        <td class="text-end">
                            <?php if (!empty($meta['pack_slug'])): ?>
                                <span class="badge badge-secondary">Included in <?= e($meta['pack_slug']) ?></span>
                            <?php else: ?>
                                <button class="btn btn-sm btn-outline-primary" onclick="alert('Please renew via Plugin Shop.')">Renew</button>
                            <?php endif; ?>
                        </td>
                    </tr>
                    <?php endforeach; ?>
                    
                    <?php if (!$coreLicense && empty($pluginLicenses)): ?>
                    <tr>
                        <td colspan="7" class="text-center py-4 text-muted">No licenses found.</td>
                    </tr>
                    <?php endif; ?>
                </tbody>
            </table>
        </div>
    </div>
</div>

<?php require __DIR__ . '/partials/footer.php'; ?>
