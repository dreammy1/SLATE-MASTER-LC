<?php
/**
 * Booking — resources/rooms CRUD + the services that consume them.
 * A service flagged "requires resource" will only offer slots when one of
 * its assigned resources is free (capacity-aware).
 */
require_once dirname(__DIR__, 3) . '/config.php';
require_once dirname(__DIR__) . '/BookingAPI.php';
require_once __DIR__ . '/_editor_ui.php';   // reusable record-editor UI kit

Auth::require();
Auth::requirePerm('booking.manage_resources');
BookingAPI::ensureSchema();

$pageTitle  = 'Resources';
$currentNav = 'booking-resources';
$tid = current_tenant_id();

$flash  = null;
$editId = isset($_GET['edit']) ? (int)$_GET['edit'] : 0;
$isNew  = !empty($_GET['new']);

$editing = null;
$linked  = [];
if ($editId > 0) {
    $editing = Database::row("SELECT * FROM booking_resources WHERE id = ? AND tenant_id = ?", [$editId, $tid]);
    if (!$editing) { http_response_code(404); $editId = 0; $editing = null; }
    else {
        $linked = array_map('intval', array_column(Database::rows(
            "SELECT service_id FROM booking_service_resources WHERE resource_id = ?", [$editId]
        ), 'service_id'));
    }
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (!csrf_verify()) {
        $flash = ['type' => 'error', 'msg' => 'Security check failed.'];
    } else {
        $action = $_POST['_action'] ?? '';
        if ($action === 'save') {
            $id   = (int)($_POST['id'] ?? 0);
            $name = trim((string)($_POST['name'] ?? ''));
            if ($name === '') {
                $flash = ['type' => 'error', 'msg' => 'Name is required.'];
            } else {
                $row = [
                    'tenant_id' => $tid,
                    'name'      => mb_substr($name, 0, 160),
                    'capacity'  => max(1, (int)($_POST['capacity'] ?? 1)),
                    'is_active' => !empty($_POST['is_active']) ? 1 : 0,
                ];
                if ($id > 0) {
                    Database::update('booking_resources', $row, 'id = ? AND tenant_id = ?', [$id, $tid]);
                    AuditLog::record('booking.resource_updated', (string)$id);
                } else {
                    $id = Database::insert('booking_resources', $row);
                    AuditLog::record('booking.resource_created', (string)$id);
                }
                // Sync assigned services.
                Database::delete('booking_service_resources', 'resource_id = ?', [$id]);
                foreach ((array)($_POST['services'] ?? []) as $sid) {
                    $sid = (int)$sid;
                    if ($sid > 0) {
                        Database::insert('booking_service_resources', ['service_id' => $sid, 'resource_id' => $id]);
                    }
                }
                $flash = ['type' => 'success', 'msg' => 'Resource saved.'];
                header('Location: ?edit=' . $id);
                exit;
            }
        } elseif ($action === 'delete') {
            $id = (int)($_POST['id'] ?? 0);
            if ($id > 0) {
                Database::delete('booking_service_resources', 'resource_id = ?', [$id]);
                Database::query("UPDATE booking_appointments SET resource_id = NULL WHERE resource_id = ? AND tenant_id = ?", [$id, $tid]);
                Database::delete('booking_resources', 'id = ? AND tenant_id = ?', [$id, $tid]);
                AuditLog::record('booking.resource_deleted', (string)$id);
                $flash = ['type' => 'success', 'msg' => 'Resource deleted.'];
                header('Location: ' . plugin_url('booking', 'admin/resources.php'));
                exit;
            }
        }
    }
}

$resources   = Database::rows("SELECT * FROM booking_resources WHERE tenant_id = ? ORDER BY name", [$tid]);
$allServices = Database::rows("SELECT id, name FROM booking_services WHERE tenant_id = ? AND is_active = 1 ORDER BY name", [$tid]);

require SLATE_ROOT . '/admin/partials/header.php';
?>

<?php slate_breadcrumbs([
    ['label' => __('dashboard', 'Dashboard'), 'href' => SLATE_URL . '/admin/'],
    ['label' => __('booking', 'Booking'), 'href' => plugin_url('booking', 'admin/index.php')],
    ['label' => 'Resources'],
]); ?>

<?php if ($flash): ?><div class="alert alert-<?= e($flash['type']) ?>" role="status"><?= e($flash['msg']) ?></div><?php endif; ?>

<?php if ($isNew || $editing):
    $r = $editing ?: ['id'=>0,'name'=>'','capacity'=>1,'is_active'=>1];
    $rInitials = ($editing && trim((string)$editing['name']) !== '') ? mb_strtoupper(mb_substr($editing['name'], 0, 2)) : '–';
?>
<?php booking_editor_css(); ?>

<?php booking_edit_open([
    'title_fallback' => 'New resource',
]); ?>

    <form method="post">
        <?= csrf_field() ?>
        <input type="hidden" name="_action" value="save">
        <input type="hidden" name="id" value="<?= (int)$r['id'] ?>">

        <?php booking_edit_backlink([
            'back_href'  => plugin_url('booking', 'admin/resources.php'),
            'back_label' => 'All resources',
        ]); ?>

        <?php booking_edit_hero([
            'icon'         => 'box',
            'initials'     => $rInitials,
            'title'        => $editing ? $editing['name'] : 'New resource',
            'ref'          => $editing ? (int)$editing['id'] : null,
            'active'       => !empty($r['is_active']),
            'toggle_name'  => 'is_active',
            'toggle_id'    => 'is_active',
            'toggle_title' => 'Active',
            'status_on'    => 'Active',
            'status_off'   => 'Inactive',
            'stats'        => $editing ? [
                ['Capacity', (string)(int)$r['capacity']],
                ['Services', (string)count($linked)],
            ] : [],
        ]); ?>

        <?php slate_page_layout('with-aside'); ?>
            <div class="page-main">
                <?php booking_edit_card_open(['icon' => 'box', 'eyebrow' => 'General', 'title' => 'Resource details']); ?>
                    <div class="field-row field-row-2">
                        <div class="field">
                            <label class="field-label" for="name">Name <span class="field-required">*</span></label>
                            <input type="text" id="name" name="name" required maxlength="160" value="<?= e($r['name']) ?>" placeholder="Room 1">
                        </div>
                        <div class="field" style="margin-bottom:0;">
                            <label class="field-label" for="capacity">Capacity (concurrent)</label>
                            <input type="number" id="capacity" name="capacity" min="1" step="1" value="<?= (int)$r['capacity'] ?>">
                        </div>
                    </div>
                    <?php booking_edit_card_note('Capacity is how many bookings can use this resource at the same time — a room that seats one, a pool of three identical machines, etc.'); ?>
                <?php booking_edit_card_close(); ?>
            </div>

            <aside class="page-aside">
                <?php booking_edit_card_open(['icon' => 'tag', 'eyebrow' => 'Services', 'title' => 'Linked services']); ?>
                    <?php if (!$allServices): ?>
                        <?php booking_edit_card_note('No services yet. <a href="' . e(plugin_url('booking', 'admin/services.php')) . '">Create one</a>.'); ?>
                    <?php else: ?>
                        <?php booking_edit_card_note('Toggle services that consume this resource, then enable “requires resource” on the service.'); ?>
                        <?php foreach ($allServices as $s):
                            booking_edit_toggle_row([
                                'name'    => 'services[]',
                                'value'   => (int)$s['id'],
                                'checked' => in_array((int)$s['id'], $linked, true),
                                'label'   => $s['name'],
                            ]);
                        endforeach; ?>
                    <?php endif; ?>
                <?php booking_edit_card_close(); ?>
            </aside>
        <?php slate_page_layout_end(); ?>

        <?php booking_edit_actionbar([
            'buttons_html' =>
                '<button type="submit" class="btn btn-primary">' . ($editing ? 'Save changes' : 'Create resource') . '</button>'
              . '<a href="' . e(plugin_url('booking', 'admin/resources.php')) . '" class="btn btn-ghost">Cancel</a>',
        ]); ?>

    </form>
<?php booking_edit_close(); ?>

<?php booking_editor_js(); ?>

<?php else: ?>
    <div class="page-header">
        <div><h1>Resources &amp; rooms</h1></div>
        <a href="?new=1" class="btn btn-primary">New resource</a>
    </div>

    <?php if (!$resources): ?>
    <div class="card"><div class="empty"><div class="empty-title">No resources yet</div><p class="text-sm">Add rooms or equipment that bookings should not double-book.</p></div></div>
    <?php else: ?>
    <div class="data-list" data-single-open>
        <?php foreach ($resources as $r):
            $svc = (int) Database::value("SELECT COUNT(*) FROM booking_service_resources WHERE resource_id = ?", [$r['id']]);
            $actions = '<a href="?edit=' . (int)$r['id'] . '" class="btn btn-sm">Edit</a> '
                     . '<form method="post" style="display:inline;margin:0;" onsubmit="return confirm(\'Delete this resource?\')">'
                     . csrf_field()
                     . '<input type="hidden" name="_action" value="delete"><input type="hidden" name="id" value="' . (int)$r['id'] . '">'
                     . '<button class="btn btn-sm btn-danger">Delete</button></form>';
            slate_data_row([
                'avatar'       => mb_substr($r['name'], 0, 1),
                'avatar_color' => $r['is_active'] ? 'accent' : 'muted',
                'title'        => $r['name'],
                'meta'         => 'Capacity ' . (int)$r['capacity'] . ' · ' . $svc . ' service(s)',
                'badge'        => $r['is_active'] ? ['Active', 'active'] : ['Inactive', 'inactive'],
                'detail'       => ['Capacity' => (int)$r['capacity'], 'Services' => $svc],
                'actions'      => $actions,
            ]);
        endforeach; ?>
    </div>
    <?php slate_data_list_script(); ?>
    <?php endif; ?>
<?php endif; ?>

<?php require SLATE_ROOT . '/admin/partials/footer.php'; ?>
