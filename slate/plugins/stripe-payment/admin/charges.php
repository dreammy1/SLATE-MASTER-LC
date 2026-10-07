<?php
/**
 * Stripe Payment — Charges admin page.
 *
 * Cross-plugin ledger of every successful Stripe charge that landed
 * via the Stripe Payment plugin. Filter by source plugin, mode,
 * status, customer email. Refund (full or partial) from inline action.
 *
 * The `stripepayment_charges` table is populated by the webhook
 * endpoint (public/webhook.php) on every `checkout.session.completed`
 * and `payment_intent.succeeded` event.
 */
require_once dirname(__DIR__, 3) . '/config.php';
require_once dirname(__DIR__) . '/StripePaymentAPI.php';

Auth::require();
Auth::requirePerm('stripe.manage_charges');
if (function_exists('slate_require_plugin_entitlement')) { slate_require_plugin_entitlement('stripe-payment'); }

StripePaymentAPI::ensureChargesSchema();

$tid = current_tenant_id();

// ── POST: refund ─────────────────────────────────────────────
$flash = null;
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (!csrf_verify()) {
        $flash = ['type' => 'error', 'msg' => 'Security check failed.'];
    } else {
        $action     = $_POST['_action'] ?? '';
        $chargeId   = (int)($_POST['id'] ?? 0);
        $amountVal  = trim((string)($_POST['amount'] ?? ''));
        if ($action === 'refund' && $chargeId > 0) {
            $amountCents = null;
            if ($amountVal !== '') {
                $amountCents = (int) round(((float)$amountVal) * 100);
            }
            $result = StripePaymentAPI::refundCharge($chargeId, $amountCents);
            if ($result['ok']) {
                $flash = ['type' => 'success',
                    'msg' => 'Refunded. Stripe refund id: ' . $result['refund_id']];
            } else {
                $flash = ['type' => 'error', 'msg' => $result['error']];
            }
        }
    }
}

// ── Filters ──────────────────────────────────────────────────
$sourcePlugin = trim((string)($_GET['source_plugin'] ?? ''));
$mode         = trim((string)($_GET['mode']          ?? ''));
$status       = trim((string)($_GET['status']        ?? ''));
$emailLike    = trim((string)($_GET['email']         ?? ''));
$days         = max(1, min(365, (int)($_GET['days'] ?? 30)));

$rows = StripePaymentAPI::listCharges([
    'source_plugin' => $sourcePlugin !== '' ? $sourcePlugin : null,
    'mode'          => $mode !== ''         ? $mode         : null,
    'status'        => $status !== ''       ? $status       : null,
    'email_like'    => $emailLike !== ''    ? $emailLike    : null,
    'days'          => $days,
], 200);

// Aside summary
$summary = Database::row(
    "SELECT
        COUNT(*) AS n,
        COALESCE(SUM(amount_cents), 0)        AS gross,
        COALESCE(SUM(refunded_cents), 0)      AS refunded,
        SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END)     AS n_succeeded,
        SUM(CASE WHEN status IN ('refunded','partial_refund') THEN 1 ELSE 0 END) AS n_refunded
       FROM stripepayment_charges
      WHERE tenant_id = ? AND created_at >= NOW() - INTERVAL " . (int)$days . " DAY",
    [$tid]
) ?: ['n'=>0,'gross'=>0,'refunded'=>0,'n_succeeded'=>0,'n_refunded'=>0];

// Distinct source plugins for filter dropdown
$plugins = array_column(Database::rows(
    "SELECT DISTINCT source_plugin FROM stripepayment_charges
      WHERE tenant_id = ? ORDER BY source_plugin", [$tid]
), 'source_plugin');

$pageTitle  = 'Stripe Charges';
$currentNav = 'shop-stripe-charges';

require SLATE_ROOT . '/admin/partials/header.php';
?>

<?php slate_breadcrumbs([
    ['label' => __('dashboard', 'Dashboard'), 'href' => SLATE_URL . '/admin/'],
    ['label' => 'Stripe', 'href' => plugin_url('stripe-payment', 'admin/settings.php')],
    ['label' => 'Charges'],
]); ?>

<div class="page-header">
    <div>
        <h1>Stripe Charges</h1>
        <p class="page-header-sub">Every Stripe charge across the active plugins.</p>
    </div>
    <div class="toolbar">
        <a href="<?= e(plugin_url('stripe-payment', 'admin/settings.php')) ?>" class="btn">Stripe settings</a>
    </div>
</div>

<?php if ($flash): ?><div class="alert alert-<?= e($flash['type']) ?>" role="status"><?= e($flash['msg']) ?></div><?php endif; ?>

<div class="card tight">
    <form method="get" class="filter-row">
        <div class="field filter-search">
            <label class="field-label" for="email">Customer email</label>
            <input type="text" id="email" name="email" value="<?= e($emailLike) ?>" placeholder="anything containing…">
        </div>
        <div class="field">
            <label class="field-label" for="source_plugin">Source plugin</label>
            <select id="source_plugin" name="source_plugin">
                <option value="">All</option>
                <?php foreach ($plugins as $sp): ?>
                    <option value="<?= e($sp) ?>" <?= $sourcePlugin === $sp ? 'selected' : '' ?>><?= e($sp) ?></option>
                <?php endforeach; ?>
            </select>
        </div>
        <div class="field">
            <label class="field-label" for="mode">Mode</label>
            <select id="mode" name="mode">
                <option value="">All</option>
                <option value="test" <?= $mode === 'test' ? 'selected' : '' ?>>Test</option>
                <option value="live" <?= $mode === 'live' ? 'selected' : '' ?>>Live</option>
            </select>
        </div>
        <div class="field">
            <label class="field-label" for="status">Status</label>
            <select id="status" name="status">
                <option value="">All</option>
                <option value="succeeded"      <?= $status === 'succeeded'      ? 'selected' : '' ?>>Succeeded</option>
                <option value="partial_refund" <?= $status === 'partial_refund' ? 'selected' : '' ?>>Partial refund</option>
                <option value="refunded"       <?= $status === 'refunded'       ? 'selected' : '' ?>>Refunded</option>
                <option value="failed"         <?= $status === 'failed'         ? 'selected' : '' ?>>Failed</option>
            </select>
        </div>
        <div class="field">
            <label class="field-label" for="days">Window</label>
            <select id="days" name="days">
                <?php foreach ([7, 30, 90, 180, 365] as $d): ?>
                    <option value="<?= $d ?>" <?= $days === $d ? 'selected' : '' ?>>Last <?= $d ?>d</option>
                <?php endforeach; ?>
            </select>
        </div>
        <div class="filter-actions">
            <button class="btn">Filter</button>
            <a href="?" class="btn btn-ghost">Reset</a>
        </div>
    </form>
</div>

<?php slate_page_layout('with-aside'); ?>

    <div class="page-main">
        <?php if (!$rows): ?>
            <div class="card"><div class="empty"><div class="empty-title">No charges in this window</div><p class="text-sm">When a customer pays through Stripe, the charge appears here.</p></div></div>
        <?php else: ?>
            <div class="data-list" data-single-open>
                <?php foreach ($rows as $r):
                    $amount   = (int)$r['amount_cents'];
                    $refunded = (int)$r['refunded_cents'];
                    $net      = max(0, $amount - $refunded);

                    $statusBadge = [
                        'succeeded'      => ['Succeeded',     'active'],
                        'partial_refund' => ['Partial refund','warning'],
                        'refunded'       => ['Refunded',      'inactive'],
                        'failed'         => ['Failed',        'danger'],
                    ][$r['status']] ?? ['?', ''];

                    $detail = [
                        'Amount'   => slate_format_price_plain((int)$amount, $r['currency']),
                        'Refunded' => $refunded > 0
                                       ? slate_format_price_plain((int)$refunded, $r['currency'])
                                       : '—',
                        'Net'      => slate_format_price_plain((int)$net, $r['currency']),
                        'Mode'     => ['label' => 'Mode', 'html' =>
                                       '<span class="badge ' . ($r['mode'] === 'live' ? 'badge-accent' : 'badge-warning') . '">'
                                       . e($r['mode']) . '</span>'],
                        'Source'   => $r['source_plugin']
                                      . ($r['source_id'] !== null && $r['source_id'] !== '' ? ' · ' . $r['source_id'] : ''),
                        'PaymentIntent' => ['label' => 'PaymentIntent', 'html' =>
                                            $r['stripe_payment_intent_id']
                                            ? '<code style="font-size:11.5px;">' . e($r['stripe_payment_intent_id']) . '</code>'
                                            : '—'],
                    ];
                    if ($r['stripe_session_id']) {
                        $detail['Session'] = ['label' => 'Session', 'html' =>
                            '<code style="font-size:11.5px;">' . e($r['stripe_session_id']) . '</code>'];
                    }

                    $canRefund = in_array($r['status'], ['succeeded', 'partial_refund'], true) && $net > 0;
                    $actions = '';
                    if ($canRefund) {
                        $maxRefund = number_format($net / 100, 2, '.', '');
                        $actions = '<form method="post" style="display:inline-flex;align-items:center;gap:6px;margin:0;" onsubmit="return confirm(\'Refund ' . $r['currency'] . ' \' + (this.amount.value || \'' . $maxRefund . '\') + \'?\')">'
                                 . csrf_field()
                                 . '<input type="hidden" name="_action" value="refund">'
                                 . '<input type="hidden" name="id" value="' . (int)$r['id'] . '">'
                                 . '<input type="number" name="amount" step="0.01" min="0.01" max="' . e($maxRefund) . '" placeholder="' . e($maxRefund) . '" style="width:100px;" class="input">'
                                 . '<button class="btn btn-sm btn-danger">Refund</button>'
                                 . '</form>';
                    } else {
                        $actions = '<span class="text-sm text-muted">No refund available</span>';
                    }

                    slate_data_row([
                        'avatar'       => mb_substr($r['source_plugin'], 0, 1),
                        'avatar_color' => $r['mode'] === 'live' ? 'success' : 'warning',
                        'title'        => ($r['customer_email'] ?: '(no email)')
                                          . ' · ' . slate_format_price_plain((int)$amount, $r['currency']),
                        'meta'         => $r['source_plugin'] . ' · ' . date('j M Y, H:i', strtotime($r['created_at'])),
                        'badge'        => $statusBadge,
                        'detail'       => $detail,
                        'actions'      => $actions,
                    ]);
                endforeach; ?>
            </div>
            <?php slate_data_list_script(); ?>
        <?php endif; ?>
    </div>

    <aside class="page-aside">
        <div class="aside-card">
            <div class="aside-card-title">Last <?= (int)$days ?> days</div>
            <ul class="kv-list">
                <li class="kv-row"><span class="kv-label">Charges</span><span class="kv-value kv-mono"><?= (int)$summary['n'] ?></span></li>
                <li class="kv-row"><span class="kv-label">Succeeded</span><span class="kv-value kv-mono"><?= (int)$summary['n_succeeded'] ?></span></li>
                <li class="kv-row"><span class="kv-label">Refunded (any)</span><span class="kv-value kv-mono"><?= (int)$summary['n_refunded'] ?></span></li>
                <li class="kv-row"><span class="kv-label">Gross</span><span class="kv-value kv-mono"><?= number_format(((int)$summary['gross']) / 100, 2) ?></span></li>
                <li class="kv-row"><span class="kv-label">Refunded</span><span class="kv-value kv-mono"><?= number_format(((int)$summary['refunded']) / 100, 2) ?></span></li>
                <li class="kv-row"><span class="kv-label">Net</span><span class="kv-value kv-mono"><strong><?= number_format((((int)$summary['gross']) - ((int)$summary['refunded'])) / 100, 2) ?></strong></span></li>
            </ul>
            <p class="text-xs text-muted mt-2">Amounts assume a single currency. Mixed-currency totals are approximate.</p>
        </div>

        <div class="aside-card">
            <div class="aside-card-title">How this works</div>
            <p class="text-sm text-muted" style="margin:0 0 var(--space-3);">
                Every <code>checkout.session.completed</code> and
                <code>payment_intent.succeeded</code> webhook from Stripe
                records a row here. Refunds call <code>StripePaymentAPI::refundCharge()</code>
                which POSTs to <code>/v1/refunds</code> and updates the row.
            </p>
            <p class="text-sm text-muted" style="margin:0;">
                Plugins integrate via the
                <code>stripe_webhook_event</code> action — see
                <code>docs/BUILDING-PLUGINS.md</code> §12.
            </p>
        </div>
    </aside>

<?php slate_page_layout_end(); ?>

<?php require SLATE_ROOT . '/admin/partials/footer.php'; ?>
