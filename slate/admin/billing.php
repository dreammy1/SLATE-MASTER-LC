<?php
/**
 * Slate — Billing / Renew (always reachable, even when license expired).
 * Shows package/domain/expiry, links to Master checkout, activates renewal keys.
 */
require_once dirname(__DIR__) . '/config.php';

Auth::require();

use Slate\Services\Licensing\LicenseService;

$tenantId = current_tenant_id();
$license = LicenseService::forTenant($tenantId);
$status = LicenseService::effectiveStatus($tenantId);
$flash = null;
$restricted = $_GET['restricted'] ?? '';
$locked = isset($_GET['locked']);

if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['_action'] ?? '') === 'activate_key') {
    if (!csrf_verify()) {
        $flash = ['type' => 'error', 'msg' => 'Security check failed.'];
    } else {
        $key = trim((string)($_POST['license_key'] ?? ''));
        $master = (string)(env('LICENSE_MASTER_URL', ''));
        if ($master === '' || $key === '') {
            $flash = ['type' => 'error', 'msg' => 'License Master URL or key missing.'];
        } else {
            $ctx = stream_context_create(['http' => [
                'method' => 'POST',
                'header' => "Content-Type: application/json\r\n",
                'content' => json_encode(['key' => $key, 'domain' => defined('SLATE_URL') ? SLATE_URL : '']),
                'timeout' => 15,
            ]]);
            $raw = @file_get_contents(rtrim($master, '/') . '/api/licenses/activate', false, $ctx);
            $data = $raw ? json_decode($raw, true) : null;
            if ($data && !empty($data['success'])) {
                $flash = ['type' => 'success', 'msg' => 'License activated. Full access restored.'];
                $license = LicenseService::forTenant($tenantId);
                $status = LicenseService::effectiveStatus($tenantId);
            } else {
                $flash = ['type' => 'error', 'msg' => 'Activation failed: ' . (($data['error'] ?? null) ?: 'unknown error')];
            }
        }
    }
}

$pageTitle = 'Billing';
$currentNav = 'billing';
require __DIR__ . '/partials/header.php';
?>
<div class="page">
  <h1>Subscription &amp; Billing</h1>
  <?php if ($flash): ?><div class="alert alert-<?= $flash['type'] === 'error' ? 'danger' : 'success' ?>"><?= e($flash['msg']) ?></div><?php endif; ?>
  <?php if ($restricted !== ''): ?><div class="alert alert-warning">That page (<?= e($restricted) ?>) needs an active license. Renew below to restore access. Your data is safe — read-only mode is on.</div><?php endif; ?>
  <?php if ($locked): ?><div class="alert alert-danger">This license is suspended/revoked. Contact support or activate a new key below.</div><?php endif; ?>
  <div class="card">
    <div>Status: <b><?= e($status) ?></b></div>
    <div>Expires: <b><?= e((string)($license['expires_at'] ?? 'Lifetime')) ?></b></div>
    <?php if (!empty($license['domain'])): ?><div>Domain: <b><?= e($license['domain']) ?></b></div><?php endif; ?>
  </div>
  <div class="card">
    <h2>Renew</h2>
    <p><a class="btn btn-primary" href="<?= e((string)(env('LICENSE_MASTER_URL', ''))) ?>/pricing?renewalOf=<?= e((string)($license['id'] ?? '')) ?>">Renew same plan →</a></p>
    <h2>Activate renewal key</h2>
    <form method="post">
      <input type="hidden" name="_action" value="activate_key">
      <input name="license_key" placeholder="SLT-XXXX-XXXX-XXXX-XXXX" style="width:320px">
      <button class="btn btn-primary" type="submit">Activate</button>
    </form>
  </div>
</div>
<?php require __DIR__ . '/partials/footer.php'; ?>
