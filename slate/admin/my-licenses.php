<?php
require_once dirname(__DIR__) . '/config.php';
require_once __DIR__ . '/../includes/shop_client.php';

Auth::require();

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
        'expired' => 'danger',
        'suspended', 'revoked', 'cancelled' => 'danger',
        default => 'secondary',
    };
};
$checkoutCycle = 'yearly';
$packageRenewUrl = $packageSlug !== '' ? shop_package_checkout_url($packageSlug, $checkoutCycle, $core['id'] ?? null) : '#token-error';

$flash = null;
if ($_SERVER['REQUEST_METHOD'] === 'POST' && (($_POST['_action'] ?? '') === 'activate_license' || ($_POST['_action'] ?? '') === 'activate_key')) {
    if (!csrf_verify()) {
        $flash = ['type' => 'error', 'msg' => 'Security check failed. Please refresh and try again.'];
    } else {
        $key = strtoupper(trim((string)($_POST['license_key'] ?? '')));
        $key = trim($key, '"\'');
        $key = preg_replace('/[\s_]+/', '-', $key);
        if (preg_match('/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/i', $key)) {
            $key = 'SLT-' . $key;
        }
        $res = shop_activate_license_key($key);
        if (!empty($res['ok'])) {
            $flash = ['type' => 'success', 'msg' => $res['message'] ?? 'License successfully activated! Full access to your dashboard has been restored.'];
            $catalog = shop_license_catalog();
            $licenseItems = $catalog['items'] ?? [];
            $core = $catalog['core'] ?? null;
            if (is_array($core)) {
                $metadata = json_decode((string)($core['metadata'] ?? ''), true);
                if (is_array($metadata)) {
                    $packageSlug = (string)($metadata['package_slug'] ?? $metadata['pack_slug'] ?? '');
                }
            }
            if ($packageSlug === '') {
                $packageSlug = (string)(getenv('SLATE_PACKAGE_SLUG') ?: '');
            }
            $packageRenewUrl = $packageSlug !== '' ? shop_package_checkout_url($packageSlug, $checkoutCycle, $core['id'] ?? null) : '#token-error';
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

<?php slate_breadcrumbs([
    ['label' => __('dashboard', 'Dashboard'), 'href' => (defined('SLATE_URL') ? SLATE_URL : '') . '/admin/'],
    ['label' => 'My Licenses'],
]); ?>

<style>
:root {
    --border-color: var(--border, #ECEDEF);
    --card-bg: var(--surface, #FFFFFF);
    --text-muted: var(--muted, #71757E);
    --text-color: var(--text, #16181D);
    --input-bg: var(--surface, #FFFFFF);
}
.license-activation-card {
    display: block !important;
    visibility: visible !important;
    margin-bottom: 1.5rem;
    border: 1px solid color-mix(in srgb, var(--accent, #7C3AED) 35%, var(--border, #ECEDEF));
    background: var(--surface, #FFFFFF);
    border-radius: var(--radius-xl, 14px);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.04);
    padding: 0;
    overflow: hidden;
}
.license-activation-head {
    padding: 1.15rem 1.4rem;
    background: linear-gradient(180deg, color-mix(in srgb, var(--accent, #7C3AED) 6%, var(--surface, #FFFFFF)) 0%, var(--surface, #FFFFFF) 100%);
    border-bottom: 1px solid var(--border, #ECEDEF);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
}
.license-activation-body {
    padding: 1.35rem 1.4rem;
    background: var(--surface, #FFFFFF);
}
.license-activate-form {
    display: flex;
    flex-wrap: wrap;
    gap: 0.85rem;
    align-items: center;
}
.license-activate-input {
    width: 100%;
    box-sizing: border-box;
    font-family: var(--font-mono, monospace);
    font-size: 1rem;
    font-weight: 600;
    letter-spacing: 1.5px;
    height: 46px;
    padding: 0.65rem 1rem;
    border-radius: var(--radius, 8px);
    border: 1.5px solid var(--border-strong, #D3D5DA);
    background: var(--surface, #FFFFFF);
    color: var(--text, #16181D);
    outline: none;
    text-transform: uppercase;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.license-activate-input:focus {
    border-color: var(--accent, #7C3AED);
    box-shadow: 0 0 0 3px var(--ring, rgba(124,58,237,0.15));
}
.license-activate-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    height: 46px;
    padding: 0 1.75rem;
    font-weight: 600;
    font-size: 0.95rem;
    cursor: pointer;
    white-space: nowrap;
    border-radius: var(--radius, 8px);
    background: var(--accent, #7C3AED);
    border: 1px solid var(--accent, #7C3AED);
    color: var(--on-accent, #FFFFFF);
    transition: background 0.15s ease, transform 0.05s ease;
}
.license-activate-btn:hover {
    background: var(--accent-deep, #6D28D9);
    border-color: var(--accent-deep, #6D28D9);
}
.badge-success { background: var(--success-soft, #DCFCE7); color: #15803D; border-color: transparent; }
.badge-warning { background: var(--warning-soft, #FEF3C7); color: #B45309; border-color: transparent; }
.badge-danger  { background: var(--danger-soft, #FEE2E2);  color: #B91C1C; border-color: transparent; }
.badge-secondary { background: var(--surface-2, #F5F6F8); color: var(--muted, #71757E); border-color: var(--border, #ECEDEF); }

.license-summary { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:1rem; margin-bottom:1.5rem; }
.license-stat { padding:1.1rem 1.25rem; border:1px solid var(--border, #ECEDEF); border-radius:var(--radius-lg, 12px); background:var(--surface, #FFFFFF); box-shadow: 0 2px 10px rgba(0,0,0,0.02); }
.license-stat-label { color:var(--muted, #71757E); font-size:.78rem; text-transform:uppercase; letter-spacing:.05em; font-weight:600; }
.license-stat-value { margin-top:.45rem; font-size:1.15rem; font-weight:700; color:var(--text, #16181D); }
.license-source { color:var(--muted, #71757E); font-size:.82rem; margin-top:.3rem; }
.license-actions { display:flex; flex-wrap:wrap; gap:.5rem; justify-content:flex-end; }
.license-key { white-space:nowrap; }
.checkout-modal[hidden], .license-details[hidden] { display:none; }
.checkout-modal, .license-details { position:fixed; inset:0; z-index:1050; display:flex; align-items:center; justify-content:center; padding:1rem; background:rgba(15,23,42,.62); }
.checkout-dialog, .license-dialog { width:min(960px,100%); height:min(760px,92vh); overflow:hidden; border-radius:14px; background:var(--surface, #FFFFFF); box-shadow:0 20px 70px rgba(0,0,0,.25); }
.license-dialog { height:auto; max-width:560px; padding:1.4rem; }
.checkout-head, .dialog-head { display:flex; align-items:center; justify-content:space-between; padding:.9rem 1rem; border-bottom:1px solid var(--border, #ECEDEF); }
.checkout-frame { width:100%; height:calc(100% - 58px); border:0; background:#fff; }
.dialog-close { border:0; background:transparent; color:var(--muted, #71757E); font-size:1.35rem; cursor:pointer; }
@media (max-width:767px) {
    .table-responsive { overflow-x:auto; }
    .license-actions { justify-content:flex-start; }
}
@media (max-width:640px) {
    .license-activate-form > div { width: 100%; min-width: 100% !important; }
    .license-activate-btn { width: 100%; justify-content: center; }
}
</style>

<div class="page-header">
    <div>
        <h1>My Licenses</h1>
        <p class="page-header-sub">View your Slate package, verify active entitlements, and activate purchased licenses</p>
    </div>
    <div style="display:flex; gap:8px;">
        <a class="btn" href="<?= e(defined('SLATE_URL') ? SLATE_URL : '') ?>/admin/plugins-shop.php">Browse Plugins</a>
    </div>
</div>

<div class="content-body">
    <?php if ($flash): ?>
        <div class="alert alert-<?= match($flash['type'] ?? '') { 'error' => 'danger', 'warning' => 'warning', default => 'success' } ?>" role="status" style="margin-bottom:1.25rem; padding:0.85rem 1.15rem; border-radius:8px;">
            <?= e($flash['msg']) ?>
        </div>
    <?php endif; ?>

    <div class="card license-activation-card" id="licenseActivationSection">
        <div class="license-activation-head">
            <div style="display:flex; align-items:center; gap:12px;">
                <div style="width:38px; height:38px; border-radius:10px; background:var(--accent-soft, #F3EEFF); color:var(--accent, #7C3AED); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <circle cx="8" cy="15" r="4"/>
                        <path d="M10.85 12.15L19 4"/>
                        <path d="M18 5l2 2"/>
                        <path d="M15 8l2 2"/>
                    </svg>
                </div>
                <div>
                    <h2 class="card-title" style="margin:0; font-size:1.1rem; color:var(--text, #16181D); font-weight:600;">Activate License Key</h2>
                    <p class="text-muted mb-0" style="font-size:0.85rem; margin:2px 0 0; color:var(--muted, #71757E);">
                        Paste the license key received after deployment or purchase to activate this site and unlock all dashboard pages.
                    </p>
                </div>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
                <span style="font-size:0.8rem; color:var(--muted, #71757E); font-weight:500;">Status:</span>
                <?php if ($core): $coreStatus = shop_license_status($core['status'] ?? null, $core['expires_at'] ?? null); ?>
                    <span class="badge badge-<?= e($statusClass($coreStatus)) ?>" style="font-size:0.8rem; padding:4px 10px; font-weight:600;">
                        <span class="dot" style="width:6px; height:6px; border-radius:999px; background:currentColor; display:inline-block; margin-right:4px;"></span>
                        <?= e(ucfirst($coreStatus)) ?>
                    </span>
                <?php else: ?>
                    <span class="badge badge-warning" style="font-size:0.8rem; padding:4px 10px; font-weight:600;">
                        <span class="dot" style="width:6px; height:6px; border-radius:999px; background:currentColor; display:inline-block; margin-right:4px;"></span>
                        Not activated
                    </span>
                <?php endif; ?>
            </div>
        </div>
        <div class="card-body license-activation-body" style="padding:1.35rem 1.4rem;">
            <form method="post" action="" class="license-activate-form" style="display:flex; flex-wrap:wrap; gap:0.75rem; align-items:center;">
                <?= csrf_field() ?>
                <input type="hidden" name="_action" value="activate_license">
                <div style="flex:1; min-width:280px;">
                    <input type="text" name="license_key" id="licenseKeyInput" required
                           placeholder="SLT-XXXX-XXXX-XXXX-XXXX"
                           pattern="[A-Za-z0-9\s-_]{14,29}"
                           title="Expected format: SLT-XXXX-XXXX-XXXX-XXXX"
                           autocomplete="off" spellcheck="false"
                           class="license-activate-input" />
                </div>
                <button type="submit" class="btn btn-primary license-activate-btn" id="activateLicenseBtn" style="padding:0.65rem 1.35rem; font-weight:600; cursor:pointer;">
                    Activate License
                </button>
            </form>
            <div style="margin-top:0.65rem; font-size:0.8rem; color:var(--muted, #71757E); display:flex; align-items:center; gap:6px;">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="16" x2="12" y2="12"/>
                    <line x1="12" y1="8" x2="12.01" y2="8"/>
                </svg>
                <span>Format: <code>SLT-XXXX-XXXX-XXXX-XXXX</code>. Keys are validated against the Master licensing authority and stored securely.</span>
            </div>
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
    const input = document.getElementById('licenseKeyInput');
    if (input) {
        const sanitize = () => {
            let v = input.value.trim().replace(/^["']|["']$/g, '').toUpperCase();
            v = v.replace(/[\s_]+/g, '-').replace(/[^A-Z0-9-]/g, '');
            if (/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(v)) {
                v = 'SLT-' + v;
            }
            input.value = v;
        };
        input.addEventListener('input', () => {
            input.value = input.value.toUpperCase().replace(/[^A-Z0-9\s-_]/g, '');
        });
        input.addEventListener('paste', () => {
            setTimeout(sanitize, 10);
        });
        input.addEventListener('blur', sanitize);
    }

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
