<?php
require_once __DIR__ . '/../includes/bootstrap.php';
require_once __DIR__ . '/../src/Services/Licensing/TenantToken.php';

Auth::requirePerm('settings.view');

$pluginSlug = $_GET['plugin'] ?? '';
if (!$pluginSlug) die('Plugin not specified');

$tenantId = current_tenant_id() ?: 1;
$domain = $_SERVER['HTTP_HOST'];
$userEmail = Auth::user()['email'] ?? '';

$token = \Slate\Services\Licensing\TenantToken::mint($tenantId, $domain, $userEmail);
if (!$token) {
    die('Cannot mint token: APP_SECRET not found.');
}

// Ensure you replace this with the real Master Dashboard URL in production
$masterUrl = 'http://localhost:3000/checkout';

// Build the query string for the embedded checkout iframe
$qs = http_build_query([
    'token' => $token,
    'type'  => 'single',
    'items' => $pluginSlug,
    'cycle' => 'monthly' // default
]);

header("Location: {$masterUrl}?{$qs}");
exit;
