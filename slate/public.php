<?php
/**
 * Slate — public-router entry point.
 *
 * Apache routes any non-file, non-directory URL to here via the
 * .htaccess rewrite. We hand the requested path to PublicRouter,
 * which matches it against plugin-registered prefixes.
 *
 * Direct file URLs (admin/*, customer/*, install.php, etc.) and
 * the existing /shop prefix do NOT come through here — they're
 * served by Apache directly, or by Shop's own router.
 */

require_once __DIR__ . '/config.php';

// Maintenance mode: show the branded 503 page to public visitors (admins pass).
require_once __DIR__ . '/includes/error_page.php';
slate_maintenance_gate();

$path = $_GET['_path'] ?? ($_SERVER['REQUEST_URI'] ?? '');
if (is_array($path)) $path = '';
$path = (string)$path;

// Strip query string defensively (REQUEST_URI fallback could include it)
if (($q = strpos($path, '?')) !== false) $path = substr($path, 0, $q);

PublicRouter::dispatch($path);
