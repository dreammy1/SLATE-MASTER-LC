<?php
/**
 * Booking — manual "Sync now" trigger from the Booking settings screen.
 * POST only, its own tiny form outside the main settings <form> (see
 * admin/settings.php) since this is an immediate action, not a save.
 */
require_once dirname(__DIR__, 3) . '/config.php';
require_once dirname(__DIR__) . '/BookingAPI.php';

Auth::require();
Auth::requirePerm('booking.manage_settings');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    exit('Method not allowed.');
}

if (!csrf_verify()) {
    header('Location: ' . plugin_url('booking', 'admin/settings.php') . '?gcal_error=' . urlencode('Security check failed.'));
    exit;
}

$summary = GoogleCalendarSync::syncNow();
header('Location: ' . plugin_url('booking', 'admin/settings.php') . '?gcal_synced=' . urlencode($summary));
exit;
