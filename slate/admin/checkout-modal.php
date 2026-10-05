<?php
require_once dirname(__DIR__) . '/config.php';
require_once __DIR__ . '/../includes/shop_client.php';

Auth::requirePerm('settings.view');

$pluginSlug = trim((string)($_GET['plugin'] ?? ''));
if ($pluginSlug === '') {
    http_response_code(400);
    exit('Plugin not specified.');
}

$checkoutUrl = shop_checkout_url($pluginSlug, (string)($_GET['cycle'] ?? 'monthly'));
$errorMessages = [
    '#invalid-product' => 'This plugin is not available for purchase.',
    '#master-unavailable' => 'The licensing Master is not configured for this site.',
    '#token-error' => 'A secure checkout token could not be created. Check APP_SECRET.',
];
if (isset($errorMessages[$checkoutUrl])) {
    http_response_code(503);
    exit($errorMessages[$checkoutUrl]);
}

header('Location: ' . $checkoutUrl, true, 302);
exit;
