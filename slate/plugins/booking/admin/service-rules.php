<?php
/**
 * Booking — per-service rules list (glass UI).
 *
 * The rules edited here are the ones gateBookingRules() enforces:
 * minimum advance days, prerequisite service, prep page, WhatsApp and
 * the automatic post-booking response.
 *
 * Uses the shared slate_data_row() list widget for a consistent look
 * with core Booking / Membership lists.
 */
require_once dirname(__DIR__, 3) . '/config.php';
require_once dirname(__DIR__) . '/BookingPlusAPI.php';

Auth::require();
Auth::requirePerm('booking.manage_services');

// The capability toggle in Booking → Settings must actually turn this page
// off, not just hide its nav link — a staff member with booking.manage_services
// could otherwise view/edit service rules via direct URL while the practice
// owner believes the feature is disabled. Same check, same 503, same position
// as booking/public/message.php's client_messaging guard.
if (!PluginLoader::isCapabilityEnabled('booking', 'service_rules')) {
    http_response_code(503);
    require SLATE_ROOT . '/admin/partials/header.php';
    echo '<div class="card"><div class="empty"><div class="empty-title">Not available</div>'
       . '<p class="text-sm">Service rules are currently disabled. Enable them in Booking &rarr; Settings.</p></div></div>';
    require SLATE_ROOT . '/admin/partials/footer.php';
    exit;
}

BookingPlusAPI::ensureSchema();

$pageTitle  = 'Booking · Service rules';
$currentNav = 'booking-service-rules';
$tid        = current_tenant_id();

$services = Database::rows(
    "SELECT s.id, s.name, s.duration_min, s.payment_mode, s.is_active, s.currency, s.price_cents,
            c.min_advance_days, c.prereq_service_id, c.auto_response_body,
            c.zoom_mode, c.zoom_join_url, c.prep_page_url
       FROM booking_services s
  LEFT JOIN bookingplus_service_config c
         ON c.service_id = s.id AND c.tenant_id = s.tenant_id
      WHERE s.tenant_id = ?
      ORDER BY s.sort_order, s.name",
    [$tid]
);

require SLATE_ROOT . '/admin/partials/header.php';

slate_breadcrumbs([
    ['label' => 'Dashboard', 'href' => SLATE_URL . '/admin/'],
    ['label' => 'Booking',   'href' => plugin_url('booking', 'admin/index.php')],
    ['label' => 'Services'],
]);
?>

<div class="page-header">
    <div>
        <h1>Booking+ Services</h1>
        <p class="text-muted">Per-service extras: preparation pages, HSR delays, prerequisites, Zoom, auto-responses.</p>
    </div>
    <a href="<?= e(plugin_url('booking', 'admin/services.php')) ?>" class="btn btn-ghost">Edit core services</a>
</div>

<?php if (!$services): ?>
    <div class="card">
        <div class="empty">
            <div class="empty-title">No booking services yet</div>
            <p class="text-sm">Create services in <a href="<?= e(plugin_url('booking', 'admin/services.php')) ?>">Booking · Services</a> first, then return here to add the extras.</p>
        </div>
    </div>
<?php else: ?>
    <div class="data-list" data-single-open>
    <?php foreach ($services as $s):
        $hasExtras = ((int)$s['min_advance_days'] > 0)
                  || !empty($s['prereq_service_id'])
                  || !empty(trim((string)$s['auto_response_body']))
                  || !empty($s['prep_page_url'])
                  || (!empty($s['zoom_join_url']) && $s['zoom_mode'] === 'manual');

        $prereqName = null;
        if (!empty($s['prereq_service_id'])) {
            $prereqName = (string) Database::value(
                "SELECT name FROM booking_services WHERE id = ? AND tenant_id = ?",
                [(int)$s['prereq_service_id'], $tid]
            );
        }

        $zoomLabel = 'Fallback message';
        if (($s['zoom_mode'] ?? '') === 'manual') {
            $zoomLabel = !empty($s['zoom_join_url']) ? 'Manual (link set)' : 'Manual (link missing)';
        } elseif (($s['zoom_mode'] ?? '') === 'api') {
            $zoomLabel = 'API (Phase 1.5)';
        }

        $detail = [
            'Duration'        => (int)$s['duration_min'] . ' min',
            'Payment'         => (string)$s['payment_mode'],
            'Min advance'     => (int)$s['min_advance_days'] > 0 ? (int)$s['min_advance_days'] . ' days' : 'no restriction',
            'Prereq'          => $prereqName ?: 'none',
            'Auto-response'   => !empty(trim((string)$s['auto_response_body'])) ? 'configured' : 'not set',
            'Zoom'            => $zoomLabel,
        ];
        if (!empty($s['prep_page_url'])) {
            $detail['Prep page'] = ['label' => 'Prep page', 'html' => '<a href="' . e($s['prep_page_url']) . '" target="_blank" rel="noopener">' . e($s['prep_page_url']) . '</a>'];
        }

        $editUrl = plugin_url('booking', 'admin/service-rule.php') . '?id=' . (int)$s['id'];
        $actions = '<a href="' . e($editUrl) . '" class="btn btn-sm btn-primary">Edit extras</a>';

        slate_data_row([
            'avatar'       => mb_strtoupper(mb_substr($s['name'], 0, 1)),
            'avatar_color' => (int)$s['is_active'] ? 'info' : 'muted',
            'title'        => $s['name'],
            'meta'         => (int)$s['duration_min'] . ' min · ' . e($s['payment_mode']),
            'badge'        => $hasExtras ? ['Extras on', 'active'] : ['Not configured', 'inactive'],
            'detail'       => $detail,
            'actions'      => $actions,
        ]);
    endforeach; ?>
    </div>
    <?php slate_data_list_script(); ?>
<?php endif; ?>

<?php require SLATE_ROOT . '/admin/partials/footer.php';
