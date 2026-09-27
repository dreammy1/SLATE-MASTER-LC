<?php
/**
 * Booking — services CRUD.
 * Single page: list + inline create/edit form (toggled by ?edit=ID
 * or ?new=1).
 */
require_once dirname(__DIR__, 3) . '/config.php';
require_once dirname(__DIR__) . '/BookingAPI.php';
require_once __DIR__ . '/_editor_ui.php';   // reusable record-editor UI kit

Auth::require();
Auth::requirePerm('booking.manage_services');
BookingAPI::ensureSchema();

$pageTitle  = 'Services';
$currentNav = 'booking-services';

$tid = current_tenant_id();

$flash = null;
$editId = isset($_GET['edit']) ? (int)$_GET['edit'] : 0;
$isNew  = !empty($_GET['new']);

$editing = null;
if ($editId > 0) {
    $editing = Database::row(
        "SELECT * FROM booking_services WHERE id = ? AND tenant_id = ?",
        [$editId, $tid]
    );
    if (!$editing) { http_response_code(404); $editing = null; $editId = 0; }
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (!csrf_verify()) {
        $flash = ['type' => 'error', 'msg' => 'Security check failed.'];
    } else {
        $action = $_POST['_action'] ?? '';
        if ($action === 'save') {
            $id    = (int)($_POST['id'] ?? 0);
            $name  = trim((string)($_POST['name'] ?? ''));
            if ($name === '') {
                $flash = ['type' => 'error', 'msg' => 'Name is required.'];
            } else {
                $paymentMode  = in_array(($_POST['payment_mode'] ?? 'free'), ['free','full','deposit','onsite'], true) ? (string)$_POST['payment_mode'] : 'free';
                $depositType  = in_array(($_POST['deposit_type'] ?? 'percent'), ['fixed','percent'], true) ? (string)$_POST['deposit_type'] : 'percent';
                $depositRaw   = (float)($_POST['deposit_value'] ?? 0);
                $depositValue = $depositType === 'fixed'
                    ? max(0, (int)round($depositRaw * 100))    // fixed = cents
                    : max(0, min(100, (int)round($depositRaw))); // percent = whole %
                // A category/location id must belong to this tenant — without
                // this, a submitted id from another tenant's catalog would be
                // stored as-is (both tables are tenant-scoped, but nothing
                // here checked before this fix).
                $categoryId = (int)($_POST['category_id'] ?? 0);
                if ($categoryId > 0 && !Database::row("SELECT id FROM booking_categories WHERE id = ? AND tenant_id = ?", [$categoryId, $tid])) {
                    $categoryId = 0;
                }
                $locationId = (int)($_POST['location_id'] ?? 0);
                if ($locationId > 0 && !Database::row("SELECT id FROM booking_locations WHERE id = ? AND tenant_id = ?", [$locationId, $tid])) {
                    $locationId = 0;
                }
                $row = [
                    'tenant_id'         => $tid,
                    'name'              => mb_substr($name, 0, 160),
                    'slug'              => BookingAPI::slugify($name, $id > 0 ? $id : null),
                    'description'       => trim((string)($_POST['description'] ?? '')) ?: null,
                    'confirm_subject'   => trim((string)($_POST['confirm_subject'] ?? '')) ?: null,
                    'confirm_body'      => trim((string)($_POST['confirm_body'] ?? '')) ?: null,
                    'category_id'       => $categoryId ?: null,
                    'location_id'       => $locationId ?: null,
                    'duration_min'      => max(5, (int)($_POST['duration_min'] ?? 30)),
                    'slot_interval_min' => max(0, (int)($_POST['slot_interval_min'] ?? 0)),
                    'buffer_before_min' => max(0, (int)($_POST['buffer_before_min'] ?? 0)),
                    'buffer_min'        => max(0, (int)($_POST['buffer_min'] ?? 0)),
                    'capacity'          => max(1, (int)($_POST['capacity'] ?? 1)),
                    'min_advance_min'   => max(0, (int)($_POST['min_advance_min'] ?? 0)),
                    'max_advance_days'  => max(0, (int)($_POST['max_advance_days'] ?? 365)),
                    'is_online'         => !empty($_POST['is_online']) ? 1 : 0,
                    'price_cents'       => max(0, (int)round(((float)($_POST['price'] ?? 0)) * 100)),
                    'currency'          => slate_default_currency(),
                    'payment_mode'      => $paymentMode,
                    'deposit_type'      => $depositType,
                    'deposit_value'     => $depositValue,
                    'tax_rate'          => max(0, min(100, (float)($_POST['tax_rate'] ?? 0))),
                    'color'             => mb_substr(trim((string)($_POST['color'] ?? '#2563EB')), 0, 16),
                    'is_active'         => !empty($_POST['is_active']) ? 1 : 0,
                ];
                if ($id > 0) {
                    Database::update('booking_services', $row, 'id = ? AND tenant_id = ?', [$id, $tid]);
                    AuditLog::record('booking.service_updated', (string)$id);
                    $flash = ['type' => 'success', 'msg' => 'Service saved.'];
                } else {
                    $id = Database::insert('booking_services', $row);
                    AuditLog::record('booking.service_created', (string)$id);
                    $flash = ['type' => 'success', 'msg' => 'Service created.'];
                }
                header('Location: ' . plugin_url('booking', 'admin/services.php'));
                exit;
            }
        } elseif ($action === 'delete') {
            $id = (int)($_POST['id'] ?? 0);
            if ($id > 0) {
                Database::delete('booking_provider_services', 'service_id = ?', [$id]);
                Database::delete('booking_services', 'id = ? AND tenant_id = ?', [$id, $tid]);
                AuditLog::record('booking.service_deleted', (string)$id);
                $flash = ['type' => 'success', 'msg' => 'Service deleted.'];
                header('Location: ' . plugin_url('booking', 'admin/services.php'));
                exit;
            }
        }
    }
}

$services = Database::rows(
    "SELECT s.*,
            (SELECT COUNT(*) FROM booking_provider_services ps WHERE ps.service_id = s.id) AS provider_count
       FROM booking_services s
      WHERE s.tenant_id = ?
   ORDER BY s.name",
    [$tid]
);

$categories = BookingAPI::getCategories();
$locations  = BookingAPI::getLocations();

require SLATE_ROOT . '/admin/partials/header.php';
?>

<?php slate_breadcrumbs([
    ['label' => __('dashboard', 'Dashboard'), 'href' => SLATE_URL . '/admin/'],
    ['label' => __('booking', 'Booking'), 'href' => plugin_url('booking', 'admin/index.php')],
    ['label' => 'Services'],
]); ?>

<?php if ($flash): ?><div class="alert alert-<?= e($flash['type']) ?>" role="status"><?= e($flash['msg']) ?></div><?php endif; ?>

<?php if ($isNew || $editing):
    $s = $editing ?: ['id'=>0,'name'=>'','description'=>'','confirm_subject'=>'','confirm_body'=>'','category_id'=>null,'location_id'=>null,
                      'duration_min'=>30,'slot_interval_min'=>0,'buffer_before_min'=>0,'buffer_min'=>0,
                      'capacity'=>1,'min_advance_min'=>0,'max_advance_days'=>365,'is_online'=>0,
                      'price_cents'=>0,'currency'=>slate_default_currency(),'payment_mode'=>'free','deposit_type'=>'percent',
                      'deposit_value'=>0,'tax_rate'=>0,'color'=>'#2563EB','is_active'=>1];
    $sInitials   = ($editing && trim((string)$editing['name']) !== '') ? mb_strtoupper(mb_substr($editing['name'], 0, 2)) : '–';
    $sProviders  = $editing ? (int) Database::value(
        "SELECT COUNT(*) FROM booking_provider_services WHERE service_id = ?", [(int)$editing['id']]) : 0;
    $sPriceLabel = ((int)$s['price_cents'] > 0)
        ? slate_format_price((int)$s['price_cents'], $s['currency'])
        : 'Free';
?>
<?php booking_editor_css(); ?>

<?php booking_edit_open([
    'title_fallback' => 'New service',
]); ?>

    <form method="post">
        <?= csrf_field() ?>
        <input type="hidden" name="_action" value="save">
        <input type="hidden" name="id" value="<?= (int)$s['id'] ?>">

        <?php booking_edit_backlink([
            'back_href'  => plugin_url('booking', 'admin/services.php'),
            'back_label' => 'All services',
        ]); ?>

        <?php booking_edit_hero([
            'icon'         => 'tag',
            'initials'     => $sInitials,
            'title'        => $editing ? $editing['name'] : 'New service',
            'ref'          => $editing ? (int)$editing['id'] : null,
            'active'       => !empty($s['is_active']),
            'toggle_name'  => 'is_active',
            'toggle_id'    => 'is_active',
            'toggle_title' => 'Active (bookable)',
            'status_on'    => 'Active · bookable',
            'status_off'   => 'Inactive',
            'stats'        => $editing ? [
                ['Duration',  (int)$s['duration_min'] . '<small>min</small>'],
                ['Price',     $sPriceLabel],
                ['Providers', (string)$sProviders],
            ] : [],
        ]); ?>

        <?php booking_edit_card_open(['icon' => 'tag', 'eyebrow' => 'General', 'title' => 'Service details']); ?>
            <div class="field-row field-row-2">
                <div class="field">
                    <label class="field-label" for="name">Name <span class="field-required">*</span></label>
                    <input type="text" id="name" name="name" required maxlength="160" value="<?= e($s['name']) ?>" placeholder="Consultation">
                </div>
                <div class="field">
                    <label class="field-label" for="color">Colour</label>
                    <input type="color" id="color" name="color" value="<?= e($s['color']) ?>">
                </div>
            </div>
            <div class="field" style="margin-bottom:0;">
                <label class="field-label" for="description">Description</label>
                <textarea id="description" name="description" maxlength="2000" placeholder="Shown on the public booking page"><?= e($s['description'] ?? '') ?></textarea>
            </div>
        <?php booking_edit_card_close(); ?>

        <?php booking_edit_card_open(['icon' => 'clock', 'eyebrow' => 'Availability', 'title' => 'Duration & scheduling']); ?>
            <div class="field-row field-row-3">
                <div class="field">
                    <label class="field-label" for="duration_min">Duration (min) <span class="field-required">*</span></label>
                    <input type="number" id="duration_min" name="duration_min" min="5" step="5" required value="<?= (int)$s['duration_min'] ?>">
                </div>
                <div class="field">
                    <label class="field-label" for="buffer_before_min">Buffer before (min)</label>
                    <input type="number" id="buffer_before_min" name="buffer_before_min" min="0" step="5" value="<?= (int)($s['buffer_before_min'] ?? 0) ?>">
                </div>
                <div class="field">
                    <label class="field-label" for="buffer_min">Buffer after (min)</label>
                    <input type="number" id="buffer_min" name="buffer_min" min="0" step="5" value="<?= (int)$s['buffer_min'] ?>">
                </div>
            </div>
            <div class="field-row field-row-3">
                <div class="field">
                    <label class="field-label" for="slot_interval_min">Slot interval (min)</label>
                    <input type="number" id="slot_interval_min" name="slot_interval_min" min="0" step="5" value="<?= (int)($s['slot_interval_min'] ?? 0) ?>" placeholder="0 = duration">
                </div>
                <div class="field">
                    <label class="field-label" for="capacity">Capacity (group)</label>
                    <input type="number" id="capacity" name="capacity" min="1" step="1" value="<?= (int)($s['capacity'] ?? 1) ?>">
                </div>
                <div class="field" style="display:flex;align-items:flex-end;">
                    <label class="switch-label">
                        <span class="switch"><input type="checkbox" name="is_online" value="1" <?= !empty($s['is_online']) ? 'checked' : '' ?>><span class="switch-track"></span></span>
                        <span>Online service</span>
                    </label>
                </div>
            </div>
            <div class="field-row field-row-2" style="margin-bottom:0;">
                <div class="field" style="margin-bottom:0;">
                    <label class="field-label" for="min_advance_min">Min advance (min)</label>
                    <input type="number" id="min_advance_min" name="min_advance_min" min="0" step="15" value="<?= (int)($s['min_advance_min'] ?? 0) ?>">
                </div>
                <div class="field" style="margin-bottom:0;">
                    <label class="field-label" for="max_advance_days">Max advance (days)</label>
                    <input type="number" id="max_advance_days" name="max_advance_days" min="0" step="1" value="<?= (int)($s['max_advance_days'] ?? 365) ?>">
                </div>
            </div>
        <?php booking_edit_card_close(); ?>

        <?php booking_edit_card_open(['icon' => 'map-pin', 'eyebrow' => 'Catalog', 'title' => 'Category & location']); ?>
            <div class="field-row field-row-2" style="margin-bottom:0;">
                <div class="field" style="margin-bottom:0;">
                    <label class="field-label" for="category_id">Category</label>
                    <select id="category_id" name="category_id">
                        <option value="0">— none —</option>
                        <?php foreach ($categories as $c): ?>
                            <option value="<?= (int)$c['id'] ?>" <?= (int)($s['category_id'] ?? 0) === (int)$c['id'] ? 'selected' : '' ?>><?= e($c['name']) ?></option>
                        <?php endforeach; ?>
                    </select>
                </div>
                <div class="field" style="margin-bottom:0;">
                    <label class="field-label" for="location_id">Location</label>
                    <select id="location_id" name="location_id">
                        <option value="0">— none —</option>
                        <?php foreach ($locations as $l): ?>
                            <option value="<?= (int)$l['id'] ?>" <?= (int)($s['location_id'] ?? 0) === (int)$l['id'] ? 'selected' : '' ?>><?= e($l['name']) ?></option>
                        <?php endforeach; ?>
                    </select>
                </div>
            </div>
        <?php booking_edit_card_close(); ?>

        <?php booking_edit_card_open(['icon' => 'tag', 'eyebrow' => 'Payments', 'title' => 'Pricing & payment']); ?>
            <div class="field-row field-row-2">
                <div class="field">
                    <label class="field-label" for="price">Price <span class="text-muted text-xs">(<?= e(slate_default_currency()) ?>)</span></label>
                    <input type="number" id="price" name="price" min="0" step="0.01" value="<?= e(number_format(((int)$s['price_cents'])/100, 2, '.', '')) ?>">
                </div>
                <div class="field">
                    <label class="field-label" for="tax_rate">Tax rate (%)</label>
                    <input type="number" id="tax_rate" name="tax_rate" min="0" max="100" step="0.001" value="<?= e(rtrim(rtrim(number_format((float)($s['tax_rate'] ?? 0), 3, '.', ''), '0'), '.')) ?>">
                </div>
            </div>
            <div class="field-row field-row-3" style="margin-bottom:0;">
                <div class="field" style="margin-bottom:0;">
                    <label class="field-label" for="payment_mode">Payment</label>
                    <select id="payment_mode" name="payment_mode">
                        <?php foreach (['free'=>'Free','full'=>'Full payment','deposit'=>'Deposit','onsite'=>'Pay on site'] as $k=>$lbl): ?>
                            <option value="<?= $k ?>" <?= (string)($s['payment_mode'] ?? 'free') === $k ? 'selected' : '' ?>><?= $lbl ?></option>
                        <?php endforeach; ?>
                    </select>
                </div>
                <div class="field" style="margin-bottom:0;">
                    <label class="field-label" for="deposit_type">Deposit type</label>
                    <select id="deposit_type" name="deposit_type">
                        <option value="percent" <?= (string)($s['deposit_type'] ?? 'percent') === 'percent' ? 'selected' : '' ?>>Percent (%)</option>
                        <option value="fixed" <?= (string)($s['deposit_type'] ?? 'percent') === 'fixed' ? 'selected' : '' ?>>Fixed amount</option>
                    </select>
                </div>
                <div class="field" style="margin-bottom:0;">
                    <label class="field-label" for="deposit_value">Deposit value</label>
                    <input type="number" id="deposit_value" name="deposit_value" min="0" step="0.01"
                           value="<?= e((string)($s['deposit_type'] ?? 'percent') === 'fixed'
                                ? number_format(((int)($s['deposit_value'] ?? 0))/100, 2, '.', '')
                                : (string)(int)($s['deposit_value'] ?? 0)) ?>">
                </div>
            </div>
        <?php booking_edit_card_close(); ?>

        <?php booking_edit_card_open(['icon' => 'calendar', 'eyebrow' => 'Notifications', 'title' => 'Confirmation email']); ?>
            <?php booking_edit_card_note('Optional per-service overrides. Leave blank to use the booking defaults. Placeholders: {{name}} {{service}} {{provider}} {{when}} {{date}} {{time}} {{ref}}'); ?>
            <div class="field">
                <label class="field-label" for="confirm_subject">Subject</label>
                <input type="text" id="confirm_subject" name="confirm_subject" maxlength="200" value="<?= e($s['confirm_subject'] ?? '') ?>" placeholder="Your booking is confirmed ({{ref}})">
            </div>
            <div class="field" style="margin-bottom:0;">
                <label class="field-label" for="confirm_body">Body <span class="text-muted text-xs">(HTML)</span></label>
                <textarea id="confirm_body" name="confirm_body" rows="4" placeholder="Leave blank for the default."><?= e($s['confirm_body'] ?? '') ?></textarea>
            </div>
        <?php booking_edit_card_close(); ?>

        <?php booking_edit_actionbar([
            'buttons_html' =>
                '<button type="submit" class="btn btn-primary">' . ($editing ? 'Save changes' : 'Create service') . '</button>'
              . '<a href="' . e(plugin_url('booking', 'admin/services.php')) . '" class="btn btn-ghost">Cancel</a>',
        ]); ?>

    </form>
<?php booking_edit_close(); ?>

<?php booking_editor_js(); ?>

<?php else: ?>
    <div class="page-header">
        <div><h1>Services</h1></div>
        <a href="?new=1" class="btn btn-primary">New service</a>
    </div>

    <?php if (!$services): ?>
    <div class="card"><div class="empty"><div class="empty-title">No services yet</div><p class="text-sm">Create one to get started.</p></div></div>
    <?php else: ?>
    <div class="data-list" data-single-open>
        <?php foreach ($services as $s):
            $detail = [
                'Duration'   => $s['duration_min'] . ' min' . ($s['buffer_min'] ? ' (+ ' . $s['buffer_min'] . ' min buffer)' : ''),
                'Price'      => $s['price_cents'] > 0 ? ['label' => 'Price', 'html' => slate_format_price((int)$s['price_cents'], $s['currency'])] : 'Free',
                'Providers'  => $s['provider_count'] . ' linked',
                'Slug'       => ['label' => 'Slug', 'html' => '<code>' . e($s['slug']) . '</code>'],
            ];
            if (!empty($s['description'])) $detail['Description'] = ['label'=>'Description','value'=>$s['description'],'muted'=>true];

            $actions = '<a href="?edit=' . (int)$s['id'] . '" class="btn btn-sm">Edit</a> '
                     . '<form method="post" style="display:inline;margin:0;" onsubmit="return confirm(\'Delete this service?\')">'
                     . csrf_field()
                     . '<input type="hidden" name="_action" value="delete">'
                     . '<input type="hidden" name="id" value="' . (int)$s['id'] . '">'
                     . '<button class="btn btn-sm btn-danger">Delete</button>'
                     . '</form>';

            slate_data_row([
                'avatar'       => mb_substr($s['name'], 0, 1),
                'avatar_color' => $s['is_active'] ? 'info' : 'muted',
                'title'        => $s['name'],
                'meta'         => $s['duration_min'] . ' min' . ($s['price_cents'] > 0 ? ' · ' . slate_format_price((int)$s['price_cents'], $s['currency']) : ''),
                'badge'        => $s['is_active'] ? ['Active', 'active'] : ['Inactive', 'inactive'],
                'detail'       => $detail,
                'actions'      => $actions,
            ]);
        endforeach; ?>
    </div>
    <?php slate_data_list_script(); ?>
    <?php endif; ?>
<?php endif; ?>

<?php require SLATE_ROOT . '/admin/partials/footer.php'; ?>
