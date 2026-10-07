<?php
require_once dirname(__DIR__) . '/config.php';
require_once __DIR__ . '/../includes/shop_client.php';

Auth::requirePerm('settings.view');

$currentNav = 'my-licenses';
$pageTitle = 'My Licenses';
$catalog = shop_license_catalog();
$licenseItems = $catalog['items'] ?? [];
$core = $catalog['core'] ?? null;

$packageSlug = '';
if (is_array($core)) {
    $metadata = json_decode((string)($core['metadata'] ?? ''), true);
    if (is_array($metadata)) {
        $packageSlug = (string)($metadata['package_slug'] ?? $metadata['pack_slug'] ?? '');
    }
}
if ($packageSlug === '') {
    $packageSlug = (string)(getenv('SLATE_PACKAGE_SLUG') ?: '');
}

$formatDate = static function ($value): string {
    if (!$value) return '—';
    $time = strtotime((string)$value);
    return $time === false ? '—' : date('M j, Y', $time);
};
$statusClass = static function (string $status): string {
    return match ($status) {
        'active', 'trial' => 'success',
        'expiring' => 'warning',
        'expired' => 'warning',
        'suspended', 'revoked', 'cancelled' => 'danger',
        default => 'secondary',
    };
};
$checkoutCycle = 'yearly';
$packageRenewUrl = $packageSlug !== '' ? shop_package_checkout_url($packageSlug, $checkoutCycle, $core['id'] ?? null) : '#token-error';

$flash = null;
if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['_action'] ?? '') === 'activate_license') {
    if (!csrf_verify()) {
        $flash = ['type' => 'error', 'msg' => 'Security check failed. Please refresh and try again.'];
    } else {
        $key = trim((string)($_POST['license_key'] ?? ''));
        $res = shop_activate_license_key($key);
        if (!empty($res['ok'])) {
            $flash = ['type' => 'success', 'msg' => $res['message'] ?? 'License successfully activated! Full access to your dashboard has been restored.'];
            $catalog = shop_license_catalog();
            $licenseItems = $catalog['items'] ?? [];
            $core = $catalog['core'] ?? null;
        } else {
            $flash = ['type' => 'error', 'msg' => $res['error'] ?? 'Activation failed. Please verify your license key.'];
        }
    }
}

if (!$flash) {
    if (!empty($_GET['expired_plugin'])) {
        $pSlug = htmlspecialchars((string)$_GET['expired_plugin']);
        $flash = ['type' => 'warning', 'msg' => "The '$pSlug' plugin license has expired. The plugin is operating in restricted read-only mode with zero data loss. Renew below to restore full access."];
    } elseif (!empty($_GET['blocked_plugin'])) {
        $pSlug = htmlspecialchars((string)$_GET['blocked_plugin']);
        $pState = htmlspecialchars((string)($_GET['state'] ?? 'unlicensed'));
        $flash = ['type' => 'error', 'msg' => "Access to the '$pSlug' plugin is restricted ($pState). All existing data is safe. Activate or purchase a license below."];
    }
}

require __DIR__ . '/partials/header.php';
?>

<style>
.license-summary { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:1rem; margin-bottom:1.25rem; }
.license-stat { padding:1rem 1.1rem; border:1px solid var(--border-color); border-radius:10px; background:var(--card-bg); }
.license-stat-label { color:var(--text-muted); font-size:.78rem; text-transform:uppercase; letter-spacing:.04em; }
.license-stat-value { margin-top:.35rem; font-size:1.08rem; font-weight:650; color:var(--text-color); }
.license-source { color:var(--text-muted); font-size:.8rem; margin-top:.2rem; }
.license-actions { display:flex; flex-wrap:wrap; gap:.5rem; justify-content:flex-end; }
.license-key { white-space:nowrap; }
.checkout-modal[hidden], .license-details[hidden] { display:none; }
.checkout-modal, .license-details { position:fixed; inset:0; z-index:1050; display:flex; align-items:center; justify-content:center; padding:1rem; background:rgba(15,23,42,.62); }
.checkout-dialog, .license-dialog { width:min(960px,100%); height:min(760px,92vh); overflow:hidden; border-radius:14px; background:var(--card-bg); box-shadow:0 20px 70px rgba(0,0,0,.25); }
.license-dialog { height:auto; max-width:560px; padding:1.4rem; }
.checkout-head, .dialog-head { display:flex; align-items:center; justify-content:space-between; padding:.9rem 1rem; border-bottom:1px solid var(--border-color); }
.checkout-frame { width:100%; height:calc(100% - 58px); border:0; background:#fff; }
.dialog-close { border:0; background:transparent; color:var(--text-muted); font-size:1.35rem; cursor:pointer; }
@media (max-width:767px) { .table-responsive { overflow-x:auto; } .license-actions { justify-content:flex-start; } }
</style>

<div class="page-header">
    <div class="ph-content">
        <h1 class="page-title">My Licenses</h1>
        <div class="page-subtitle">View your Slate package and plugin entitlements</div>
    </div>
    <div class="ph-actions">
        <a class="btn btn-primary" href="<?= e(SLATE_URL) ?>/admin/plugins-shop.php">Browse Plugins</a>
    </div>
</div>

<div class="content-body">
    <?php if ($flash): ?>
        <div class="alert alert-<?= match($flash['type'] ?? '') { 'error' => 'danger', 'warning' => 'warning', default => 'success' } ?>" role="status" style="margin-bottom:1.25rem; padding:0.85rem 1.15rem; border-radius:8px;">
            <?= e($flash['msg']) ?>
        </div>
    <?php endif; ?>

    <div class="card license-activation-card" style="margin-bottom:1.5rem; border:1px solid #00f0ff44; background:var(--card-bg, #111625); border-radius:10px;">
        <div class="card-header" style="padding:1rem 1.25rem; border-bottom:1px solid var(--border-color); display:flex; flex-direction:column; gap:0.25rem;">
            <h2 class="card-title" style="margin:0; font-size:1.1rem; color:var(--text-color); font-weight:600;">Activate License Key</h2>
            <p class="text-muted mb-0" style="font-size:0.85rem; margin:0;">
                Paste the license key received after deployment or purchase to activate this site and unlock all dashboard pages.
            </p>
        </div>
        <div class="card-body" style="padding:1.25rem;">
            <form method="post" action="" class="license-activate-form" style="display:flex; flex-wrap:wrap; gap:0.75rem; align-items:center;">
                <?= csrf_field() ?>
                <input type="hidden" name="_action" value="activate_license">
                <div style="flex:1; min-width:280px;">
                    <input type="text" name="license_key" id="licenseKeyInput" required
                           placeholder="SLT-XXXX-XXXX-XXXX-XXXX"
                           pattern="SLT-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}"
                           title="Expected format: SLT-XXXX-XXXX-XXXX-XXXX"
                           autocomplete="off" spellcheck="false"
                           style="width:100%; box-sizing:border-box; font-family:monospace; font-size:1rem; letter-spacing:1px; padding:0.65rem 0.85rem; border-radius:6px; border:1px solid var(--border-color); background:var(--input-bg, #0a0d14); color:var(--text-color, #fff);" />
                </div>
                <button type="submit" class="btn btn-primary" id="activateLicenseBtn" style="padding:0.65rem 1.35rem; font-weight:600; cursor:pointer;">
                    Activate License
                </button>
            </form>
        </div>
    </div>

    <div class="license-summary">
        <div class="license-stat">
            <div class="license-stat-label">Package</div>
            <div class="license-stat-value"><?= e($packageSlug !== '' ? ucwords(str_replace('-', ' ', $packageSlug)) : 'Slate Core') ?></div>
            <div class="license-source"><?= $core ? 'Core license found' : 'No core package license' ?></div>
        </div>
        <div class="license-stat">
            <div class="license-stat-label">Core status</div>
            <div class="license-stat-value">
                <?php if ($core): $coreStatus = shop_license_status($core['status'] ?? null, $core['expires_at'] ?? null); ?>
                    <span class="badge badge-<?= e($statusClass($coreStatus)) ?>"><?= e(ucfirst($coreStatus)) ?></span>
                <?php else: ?>
                    <span class="badge badge-secondary">Not activated</span>
                <?php endif; ?>
            </div>
            <div class="license-source"><?= $core ? 'Expires ' . e($formatDate($core['expires_at'] ?? null)) : 'Activate a license to unlock paid features' ?></div>
        </div>
        <div class="license-stat">
            <div class="license-stat-label">Plugin licenses</div>
            <div class="license-stat-value"><?= e((string)count($catalog['plugins'] ?? [])) ?></div>
            <div class="license-source">Standalone and package entitlements</div>
        </div>
    </div>

    <div class="card">
        <div class="card-header d-flex justify-content-between align-items-center">
            <div>
                <h2 class="card-title">License inventory</h2>
                <p class="text-muted mb-0">Your license status, activation dates, and renewal options.</p>
            </div>
            <?php if ($core && $packageSlug !== ''): ?>
                <button class="btn btn-sm btn-outline-primary" type="button" data-checkout-url="<?= e($packageRenewUrl) ?>" data-checkout-title="Renew package">Renew package</button>
            <?php endif; ?>
        </div>
        <div class="table-responsive">
            <table class="table">
                <thead>
                    <tr>
                        <th>Product</th>
                        <th>Source</th>
                        <th>Status</th>
                        <th>Activated</th>
                        <th>Expires</th>
                        <th>Key</th>
                        <th class="text-end">Actions</th>
                    </tr>
                </thead>
                <tbody>
                <?php foreach ($licenseItems as $item):
                    $status = (string)($item['status'] ?? 'unowned');
                    $source = (string)($item['source'] ?? 'single');
                    $isPackage = $source === 'package';
                    $renewUrl = $isPackage
                        ? ($item['package_slug'] ? shop_package_checkout_url((string)$item['package_slug'], $checkoutCycle, (string)($item['license_id'] ?? '')) : $packageRenewUrl)
                        : shop_checkout_url((string)($item['product_slug'] ?? ''), $checkoutCycle, (string)($item['license_id'] ?? ''));
                ?>
                    <tr>
                        <td>
                            <strong><?= e((string)($item['product_name'] ?? 'License')) ?></strong>
                            <div class="license-source"><?= e($item['product_type'] === 'plugin' ? 'Plugin' : 'Slate Core') ?></div>
                        </td>
                        <td>
                            <?php if ($isPackage): ?>
                                <span class="badge badge-secondary">Included<?= $item['package_slug'] ? ' in ' . e((string)$item['package_slug']) : '' ?></span>
                            <?php else: ?>
                                <span class="badge badge-secondary">Standalone</span>
                            <?php endif; ?>
                        </td>
                        <td><span class="badge badge-<?= e($statusClass($status)) ?>"><?= e(ucfirst($status)) ?></span></td>
                        <td><?= e($formatDate($item['starts_at'] ?? null)) ?></td>
                        <td><?= $item['expires_at'] ? e($formatDate($item['expires_at'])) : 'Lifetime' ?></td>
                        <td>
                            <?php if (!empty($item['key_last4'])): ?>
                                <code class="text-muted license-key">****<?= e((string)$item['key_last4']) ?></code>
                            <?php elseif ($item['product_type'] === 'core'): ?>
                                <code class="text-muted license-key">Protected</code>
                            <?php else: ?>—<?php endif; ?>
                        </td>
                        <td class="text-end">
                            <div class="license-actions">
                                <?php if ($isPackage): ?>
                                    <button class="btn btn-sm btn-outline-primary" type="button" data-checkout-url="<?= e($renewUrl) ?>" data-checkout-title="Renew package">Renew package</button>
                                <?php elseif (!empty($item['renewable'])): ?>
                                    <button class="btn btn-sm btn-outline-primary" type="button" data-checkout-url="<?= e($renewUrl) ?>" data-checkout-title="Renew plugin">Renew</button>
                                <?php else: ?>
                                    <span class="text-muted">No action</span>
                                <?php endif; ?>
                            </div>
                        </td>
                    </tr>
                <?php endforeach; ?>
                <?php if (!$licenseItems): ?>
                    <tr><td colspan="7" class="text-center py-4 text-muted">No licenses found for this tenant.</td></tr>
                <?php endif; ?>
                </tbody>
            </table>
        </div>
    </div>
</div>

<div class="checkout-modal" id="checkoutModal" hidden role="dialog" aria-modal="true" aria-labelledby="checkoutModalTitle">
    <div class="checkout-dialog">
        <div class="checkout-head">
            <strong id="checkoutModalTitle">Checkout</strong>
            <button class="dialog-close" type="button" data-close-checkout aria-label="Close">&times;</button>
        </div>
        <iframe class="checkout-frame" id="checkoutFrame" title="Secure checkout" src="about:blank"></iframe>
    </div>
</div>

<script>
(() => {
    const modal = document.getElementById('checkoutModal');
    const frame = document.getElementById('checkoutFrame');
    const title = document.getElementById('checkoutModalTitle');
    let frameOrigin = '';
    const close = () => { modal.hidden = true; frame.src = 'about:blank'; frameOrigin = ''; };
    document.querySelectorAll('[data-checkout-url]').forEach((button) => {
        button.addEventListener('click', () => {
            const url = button.dataset.checkoutUrl || '#token-error';
            if (url === '#token-error') { window.alert('Checkout is not configured for this site yet.'); return; }
            let parsed;
            try { parsed = new URL(url, window.location.href); } catch { window.alert('Checkout URL is invalid.'); return; }
            if (!['http:', 'https:'].includes(parsed.protocol)) { window.alert('Checkout URL is invalid.'); return; }
            frameOrigin = parsed.origin;
            title.textContent = button.dataset.checkoutTitle || 'Checkout';
            frame.src = url;
            modal.hidden = false;
        });
    });
    document.querySelector('[data-close-checkout]')?.addEventListener('click', close);
    modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !modal.hidden) close(); });
    window.addEventListener('message', (event) => {
        if (modal.hidden || event.source !== frame.contentWindow || !frameOrigin || event.origin !== frameOrigin) return;
        const message = event.data || {};
        if (message.version !== 1) return;
        if (message.type === 'slate.checkout.completed') { close(); window.location.reload(); }
        else if (message.type === 'slate.checkout.cancelled') close();
        else if (message.type === 'slate.checkout.failed') { close(); window.alert('Checkout failed. Please try again.'); }
    });
})();
</script>

<?php require __DIR__ . '/partials/footer.php'; ?>
