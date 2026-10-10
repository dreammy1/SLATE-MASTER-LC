<?php
/**
 * Slate — Billing / Renew (always reachable, even when license expired).
 * Shows package/domain/expiry, links to Master checkout, activates renewal keys.
 */
require_once dirname(__DIR__) . '/config.php';
require_once __DIR__ . '/../includes/shop_client.php';

Auth::require();

use Slate\Services\Licensing\LicenseService;

$tenantId = current_tenant_id();
$license = LicenseService::forTenant($tenantId);
$status = LicenseService::effectiveStatus($tenantId);
$flash = null;
$restricted = $_GET['restricted'] ?? '';
$locked = isset($_GET['locked']);

if ($_SERVER['REQUEST_METHOD'] === 'POST' && (($_POST['_action'] ?? '') === 'activate_key' || ($_POST['_action'] ?? '') === 'activate_license')) {
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
            $flash = ['type' => 'success', 'msg' => $res['message'] ?? 'License activated. Full access restored.'];
            $license = LicenseService::forTenant($tenantId);
            $status = LicenseService::effectiveStatus($tenantId);
        } else {
            $flash = ['type' => 'error', 'msg' => $res['error'] ?? 'Activation failed. Please check your license key.'];
        }
    }
}

$pageTitle = 'Billing & Subscriptions';
$currentNav = 'billing';
require __DIR__ . '/partials/header.php';
?>
<div class="page" style="max-width: 960px; margin: 0 auto; padding: 24px 16px;">
  <?= slate_breadcrumbs([
      ['label' => __('dashboard', 'Dashboard'), 'href' => SLATE_URL . '/admin/'],
      ['label' => 'Subscription & Billing'],
  ]) ?>

  <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; flex-wrap: wrap; gap: 12px;">
    <div>
      <h1 style="font-size: 1.75rem; font-weight: 700; color: var(--text, #16181D); margin: 0 0 6px 0;">Subscription &amp; Billing</h1>
      <p style="color: var(--muted, #71757E); font-size: 0.95rem; margin: 0;">Manage your site license, renew packages, or activate purchased license keys.</p>
    </div>
    <div>
      <a href="<?= e(defined('SLATE_URL') ? SLATE_URL . '/admin/my-licenses.php' : 'my-licenses.php') ?>" class="btn btn-secondary" style="display: inline-flex; align-items: center; gap: 8px;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 2l-2 2m-1-1l-3 3m2-4l-3 3m-4 4l-4 4a2 2 0 01-2.83 0l-2.17-2.17a2 2 0 010-2.83l4-4a2 2 0 012.83 0l.17.17M15 8l2 2"/>
        </svg>
        Manage All Licenses &rarr;
      </a>
    </div>
  </div>

  <?php if ($flash): ?>
    <div class="alert alert-<?= $flash['type'] === 'error' ? 'danger' : ($flash['type'] === 'warning' ? 'warning' : 'success') ?>" style="margin-bottom: 20px;">
      <?= e($flash['msg']) ?>
    </div>
  <?php endif; ?>

  <?php if ($restricted !== ''): ?>
    <div class="alert alert-warning" style="margin-bottom: 20px;">
      That page (<?= e($restricted) ?>) needs an active license. Activate a key below to restore access. Your data is completely safe — read-only mode is active.
    </div>
  <?php endif; ?>

  <?php if ($locked): ?>
    <div class="alert alert-danger" style="margin-bottom: 20px;">
      This license is suspended or revoked. Contact support or activate a new valid key below.
    </div>
  <?php endif; ?>

  <!-- Current License Status Card -->
  <div class="card" style="background: var(--surface, #FFFFFF); border: 1px solid var(--border-strong, #E2E4E9); border-radius: 12px; padding: 24px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.04);">
    <h2 style="font-size: 1.15rem; font-weight: 600; color: var(--text, #16181D); margin: 0 0 16px 0;">Current License Status</h2>
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px;">
      <div>
        <div style="font-size: 0.8rem; color: var(--muted, #71757E); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; margin-bottom: 4px;">Status</div>
        <div style="font-size: 1.1rem; font-weight: 600;">
          <?php if (in_array(strtolower((string)$status), ['active', 'trial'], true)): ?>
            <span class="badge badge-success" style="display: inline-block; padding: 4px 10px; border-radius: 999px; background: rgba(34, 197, 94, 0.12); color: #15803d; font-size: 0.85rem; font-weight: 600;"><?= e(ucfirst($status)) ?></span>
          <?php elseif (in_array(strtolower((string)$status), ['expired', 'suspended', 'revoked'], true)): ?>
            <span class="badge badge-danger" style="display: inline-block; padding: 4px 10px; border-radius: 999px; background: rgba(239, 68, 68, 0.12); color: #b91c1c; font-size: 0.85rem; font-weight: 600;"><?= e(ucfirst($status)) ?></span>
          <?php else: ?>
            <span class="badge badge-secondary" style="display: inline-block; padding: 4px 10px; border-radius: 999px; background: #e2e8f0; color: #475569; font-size: 0.85rem; font-weight: 600;"><?= e(ucfirst($status ?: 'Not activated')) ?></span>
          <?php endif; ?>
        </div>
      </div>
      <div>
        <div style="font-size: 0.8rem; color: var(--muted, #71757E); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; margin-bottom: 4px;">Expiration Date</div>
        <div style="font-size: 1rem; color: var(--text, #16181D); font-weight: 500;"><?= e((string)($license['expires_at'] ?? 'Lifetime / No Expiry')) ?></div>
      </div>
      <div>
        <div style="font-size: 0.8rem; color: var(--muted, #71757E); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; margin-bottom: 4px;">Registered Domain</div>
        <div style="font-size: 1rem; color: var(--text, #16181D); font-weight: 500;"><?= e($license['domain'] ?? ($_SERVER['HTTP_HOST'] ?? '—')) ?></div>
      </div>
    </div>
  </div>

  <!-- Activate License Key Card -->
  <div class="card license-activation-card" style="background: var(--surface, #FFFFFF); border: 1px solid var(--border-strong, #E2E4E9); border-radius: 12px; padding: 24px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.04);">
    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
      <div style="width: 40px; height: 40px; border-radius: 8px; background: rgba(99, 102, 241, 0.1); color: var(--accent, #6366f1); display: flex; align-items: center; justify-content: center;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 2l-2 2m-1-1l-3 3m2-4l-3 3m-4 4l-4 4a2 2 0 01-2.83 0l-2.17-2.17a2 2 0 010-2.83l4-4a2 2 0 012.83 0l.17.17M15 8l2 2"/>
        </svg>
      </div>
      <div>
        <h2 style="font-size: 1.15rem; font-weight: 600; color: var(--text, #16181D); margin: 0 0 4px 0;">Activate License Key</h2>
        <p style="font-size: 0.875rem; color: var(--muted, #71757E); margin: 0;">Enter your license key from your purchase confirmation or client portal.</p>
      </div>
    </div>

    <form method="post" action="" style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
      <?= csrf_field() ?>
      <input type="hidden" name="_action" value="activate_license">
      <div style="position: relative; flex: 1; min-width: 280px; max-width: 420px;">
        <input
          type="text"
          name="license_key"
          id="billingLicenseKeyInput"
          placeholder="SLT-XXXX-XXXX-XXXX-XXXX"
          required
          pattern="[A-Za-z0-9\s-_]{14,29}"
          class="form-control"
          style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600; width: 100%; padding: 10px 14px; border: 1px solid var(--border-strong, #E2E4E9); border-radius: 8px; font-size: 0.95rem; background: var(--surface, #FFFFFF); color: var(--text, #16181D);"
        >
      </div>
      <button class="btn btn-primary" id="billingActivateBtn" type="submit" style="padding: 10px 20px; font-weight: 600;">
        Activate License
      </button>
    </form>
  </div>

  <!-- Renew Plan Card -->
  <?php 
    $masterUrl = (string)(env('LICENSE_MASTER_URL', '') ?: getenv('LICENSE_MASTER_URL') ?: '');
    if ($masterUrl !== ''):
  ?>
  <div class="card" style="background: var(--surface, #FFFFFF); border: 1px solid var(--border-strong, #E2E4E9); border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.04);">
    <h2 style="font-size: 1.15rem; font-weight: 600; color: var(--text, #16181D); margin: 0 0 8px 0;">Need to Renew or Upgrade?</h2>
    <p style="color: var(--muted, #71757E); font-size: 0.9rem; margin-bottom: 16px;">
      Extend your plan before it expires to prevent feature interruption and keep automatic updates active.
    </p>
    <a class="btn btn-primary" href="<?= e(rtrim($masterUrl, '/')) ?>/pricing?renewalOf=<?= e((string)($license['id'] ?? '')) ?>" target="_blank" rel="noopener">
      Renew or Change Plan &rarr;
    </a>
  </div>
  <?php endif; ?>
</div>

<script>
(function() {
  var input = document.getElementById('billingLicenseKeyInput');
  if (input) {
    var sanitize = function() {
      var v = input.value.trim().replace(/^["']|["']$/g, '').toUpperCase();
      v = v.replace(/[\s_]+/g, '-').replace(/[^A-Z0-9-]/g, '');
      if (/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(v)) {
        v = 'SLT-' + v;
      }
      input.value = v;
    };
    input.addEventListener('input', function(e) {
      this.value = this.value.toUpperCase().replace(/[^A-Z0-9\s-_]/g, '');
    });
    input.addEventListener('paste', function(e) {
      setTimeout(sanitize, 10);
    });
    input.addEventListener('blur', sanitize);
  }
})();
</script>

<?php require __DIR__ . '/partials/footer.php'; ?>
