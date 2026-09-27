<?php
/**
 * Booking — customers: profiles, no-show / loyalty, tags, history,
 * GDPR export + delete.
 */
require_once dirname(__DIR__, 3) . '/config.php';
require_once dirname(__DIR__) . '/BookingAPI.php';

Auth::require();
Auth::requirePerm('booking.view');
BookingAPI::ensureSchema();

$pageTitle  = 'Customers';
$currentNav = 'booking-customers';
$tid = current_tenant_id();

$canManage = Auth::can('booking.manage_appointments');
$flash  = null;
$viewId = (int)($_GET['id'] ?? 0);

// GDPR export (JSON download) — must run before any output.
if ($viewId > 0 && !empty($_GET['export'])) {
    $cust = BookingAPI::getBookingCustomer($viewId);
    if ($cust) {
        $data = BookingAPI::exportCustomerData($cust['email']);
        header('Content-Type: application/json');
        header('Content-Disposition: attachment; filename="booking-customer-' . $viewId . '.json"');
        echo json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && $canManage) {
    if (!csrf_verify()) {
        $flash = ['type' => 'error', 'msg' => 'Security check failed.'];
    } else {
        $action = $_POST['_action'] ?? '';
        $id = (int)($_POST['id'] ?? 0);
        if ($action === 'save' && $id > 0) {
            $bday = trim((string)($_POST['birthday'] ?? ''));
            BookingAPI::updateCustomerProfile($id, [
                'name'           => mb_substr(trim((string)($_POST['name'] ?? '')), 0, 160),
                'phone'          => mb_substr(trim((string)($_POST['phone'] ?? '')), 0, 40) ?: null,
                'birthday'       => preg_match('/^\d{4}-\d{2}-\d{2}$/', $bday) ? $bday : null,
                'notes'          => trim((string)($_POST['notes'] ?? '')) ?: null,
                'tags'           => mb_substr(trim((string)($_POST['tags'] ?? '')), 0, 255) ?: null,
                'loyalty_points' => max(0, (int)($_POST['loyalty_points'] ?? 0)),
            ]);
            $flash = ['type' => 'success', 'msg' => 'Customer saved.'];
            header('Location: ?id=' . $id);
            exit;
        } elseif ($action === 'gdpr_delete' && $id > 0) {
            $cust = BookingAPI::getBookingCustomer($id);
            if ($cust) BookingAPI::deleteCustomerData($cust['email']);
            $flash = ['type' => 'success', 'msg' => 'Customer data deleted.'];
            header('Location: ' . plugin_url('booking', 'admin/customers.php'));
            exit;
        }
    }
}

$viewing = $viewId > 0 ? BookingAPI::getBookingCustomer($viewId) : null;
$history = $viewing ? BookingAPI::customerHistory($viewing['email']) : [];

$search = trim((string)($_GET['q'] ?? ''));
$tag    = trim((string)($_GET['tag'] ?? ''));
$customers = $viewing ? [] : BookingAPI::getBookingCustomers($search, $tag);

require SLATE_ROOT . '/admin/partials/header.php';
?>

<?php slate_breadcrumbs([
    ['label' => __('dashboard', 'Dashboard'), 'href' => SLATE_URL . '/admin/'],
    ['label' => __('booking', 'Booking'), 'href' => plugin_url('booking', 'admin/index.php')],
    ['label' => 'Customers', 'href' => plugin_url('booking', 'admin/customers.php')],
]); ?>

<?php if ($flash): ?><div class="alert alert-<?= e($flash['type']) ?>"><?= e($flash['msg']) ?></div><?php endif; ?>

<?php if ($viewing): ?>
    <div class="page-header">
        <div><h1><?= e($viewing['name']) ?></h1><p class="page-header-sub"><?= e($viewing['email']) ?></p></div>
        <a href="<?= e(plugin_url('booking', 'admin/customers.php')) ?>" class="btn btn-ghost">&larr; All customers</a>
    </div>

    <?php slate_page_layout('with-aside'); ?>
        <div class="page-main">
            <?php if ($canManage): ?>
            <div class="card">
                <div class="card-header"><h2>Profile</h2></div>
                <form method="post">
                    <?= csrf_field() ?>
                    <input type="hidden" name="_action" value="save">
                    <input type="hidden" name="id" value="<?= (int)$viewing['id'] ?>">
                    <div class="field-row field-row-2">
                        <div class="field">
                            <label class="field-label" for="name">Name</label>
                            <input type="text" id="name" name="name" maxlength="160" value="<?= e($viewing['name']) ?>">
                        </div>
                        <div class="field">
                            <label class="field-label" for="phone">Phone</label>
                            <input type="tel" id="phone" name="phone" maxlength="40" value="<?= e($viewing['phone'] ?? '') ?>">
                        </div>
                    </div>
                    <div class="field-row field-row-2">
                        <div class="field">
                            <label class="field-label" for="birthday">Birthday</label>
                            <input type="date" id="birthday" name="birthday" value="<?= e($viewing['birthday'] ?? '') ?>">
                        </div>
                        <div class="field">
                            <label class="field-label" for="loyalty_points">Loyalty points</label>
                            <input type="number" id="loyalty_points" name="loyalty_points" min="0" step="1" value="<?= (int)$viewing['loyalty_points'] ?>">
                        </div>
                    </div>
                    <div class="field">
                        <label class="field-label" for="tags">Tags <span class="text-muted text-xs">(comma-separated)</span></label>
                        <input type="text" id="tags" name="tags" maxlength="255" value="<?= e($viewing['tags'] ?? '') ?>" placeholder="vip, regular">
                    </div>
                    <div class="field">
                        <label class="field-label" for="notes">Notes</label>
                        <textarea id="notes" name="notes" maxlength="2000"><?= e($viewing['notes'] ?? '') ?></textarea>
                    </div>
                    <div class="flex gap-2 mt-3"><button type="submit" class="btn btn-primary">Save profile</button></div>
                </form>
            </div>
            <?php endif; ?>

            <div class="card">
                <div class="card-header"><h2>History (<?= count($history) ?>)</h2></div>
                <?php if (!$history): ?>
                    <div class="empty"><div class="empty-title">No appointments</div></div>
                <?php else: ?>
                    <ul class="kv-list">
                        <?php foreach ($history as $h): ?>
                            <li class="kv-row">
                                <span class="kv-label"><strong style="color:var(--text);"><?= e($h['service_name']) ?></strong><br>
                                    <span class="text-xs"><?= e($h['provider_name']) ?> · <?= e(ucfirst((string)$h['status'])) ?></span></span>
                                <span class="kv-value"><a href="<?= e(plugin_url('booking', 'admin/appointment.php')) ?>?id=<?= (int)$h['id'] ?>"><?= e(slate_format_datetime($h['starts_at'], 'j M Y')) ?></a></span>
                            </li>
                        <?php endforeach; ?>
                    </ul>
                <?php endif; ?>
            </div>
        </div>
        <aside class="page-aside">
            <div class="aside-card">
                <div class="aside-card-title">Stats</div>
                <ul class="kv-list">
                    <li class="kv-row"><span class="kv-label">Bookings</span><span class="kv-value"><?= (int)$viewing['booking_count'] ?></span></li>
                    <li class="kv-row"><span class="kv-label">Completed</span><span class="kv-value"><?= (int)$viewing['completed_count'] ?></span></li>
                    <li class="kv-row"><span class="kv-label">No-shows</span><span class="kv-value"><?= (int)$viewing['no_show_count'] ?></span></li>
                    <li class="kv-row"><span class="kv-label">Loyalty</span><span class="kv-value"><?= (int)$viewing['loyalty_points'] ?> pts</span></li>
                </ul>
            </div>
            <?php if ($canManage): ?>
            <div class="aside-card">
                <div class="aside-card-title">GDPR</div>
                <p class="text-sm text-muted">Export or erase this customer's booking data.</p>
                <a href="?id=<?= (int)$viewing['id'] ?>&export=1" class="btn btn-sm btn-block">Export data (JSON)</a>
                <form method="post" class="mt-2" onsubmit="return confirm('Erase all personal data for this customer? Appointments will be anonymised.')">
                    <?= csrf_field() ?>
                    <input type="hidden" name="_action" value="gdpr_delete">
                    <input type="hidden" name="id" value="<?= (int)$viewing['id'] ?>">
                    <button class="btn btn-sm btn-danger btn-block">Delete &amp; anonymise</button>
                </form>
            </div>
            <?php endif; ?>
        </aside>
    <?php slate_page_layout_end(); ?>

<?php else: ?>
    <div class="page-header"><div><h1>Customers</h1></div></div>
    <div class="card tight">
        <form method="get" class="filter-row">
            <div class="field filter-search">
                <label class="field-label" for="q">Search</label>
                <input type="search" id="q" name="q" value="<?= e($search) ?>" placeholder="name, email, phone">
            </div>
            <div class="field">
                <label class="field-label" for="tag">Tag</label>
                <input type="text" id="tag" name="tag" value="<?= e($tag) ?>" placeholder="vip">
            </div>
            <div class="filter-actions">
                <button class="btn">Filter</button>
                <a href="?" class="btn btn-ghost">Reset</a>
            </div>
        </form>
    </div>

    <?php if (!$customers): ?>
        <div class="card"><div class="empty"><div class="empty-title">No customers yet</div><p class="text-sm">Booking customers appear here once they book.</p></div></div>
    <?php else: ?>
        <div class="data-list" data-single-open>
            <?php foreach ($customers as $c):
                $tags = array_filter(array_map('trim', explode(',', (string)($c['tags'] ?? ''))));
                $detail = [
                    'Email'     => $c['email'],
                    'Phone'     => $c['phone'] ?: '—',
                    'Bookings'  => (int)$c['booking_count'],
                    'Completed' => (int)$c['completed_count'],
                    'No-shows'  => (int)$c['no_show_count'],
                    'Loyalty'   => (int)$c['loyalty_points'] . ' pts',
                ];
                if ($tags) $detail['Tags'] = implode(', ', $tags);
                $actions = '<a href="?id=' . (int)$c['id'] . '" class="btn btn-sm btn-primary">Open</a>';
                slate_data_row([
                    'avatar_html'  => slate_avatar_overlay_html(mb_substr($c['name'], 0, 1), (string)($c['email'] ?? '')),
                    'avatar_color' => (int)$c['no_show_count'] > 0 ? 'warning' : 'info',
                    'title'        => $c['name'],
                    'meta'         => $c['email'] . ' · ' . (int)$c['booking_count'] . ' booking(s)',
                    'badge'        => (int)$c['loyalty_points'] > 0 ? [(int)$c['loyalty_points'] . ' pts', 'accent'] : ['Customer', 'inactive'],
                    'detail'       => $detail,
                    'actions'      => $actions,
                ]);
            endforeach; ?>
        </div>
        <?php slate_data_list_script(); ?>
    <?php endif; ?>
<?php endif; ?>

<?php require SLATE_ROOT . '/admin/partials/footer.php'; ?>
