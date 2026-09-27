<?php

/**
 * Temporary: prove the fixed write_config logic actually creates .env and
 * rewrites config.php, by exercising the same code paths in isolation.
 */
$dir = sys_get_temp_dir() . '/slate-envtest-' . uniqid();
mkdir($dir, 0755, true);

// A config.php with a foreign demo fallback (the real-world symptom).
file_put_contents($dir . '/config.php', <<<'PHP'
<?php
// ── App URL + tenant ─────────────────────────────────────────
define('SLATE_URL', rtrim(env('APP_URL', 'https://greenlightinduction.rakibhasaan.com/slate'), '/'));
define('TENANT_ID', (int)env('TENANT_ID', 1));
PHP);

$payload = [
    'site_url' => 'https://whatever-bar.de/slate',
    'db_host' => 'localhost',
    'db_name' => 'whatever_bbbe',
    'db_user' => 'whatever_ubbbe',
    'db_password' => 'p%$#8JNZuQVF#otpp7',
    'base_path' => '/slate',
    'extra_env' => ['APP_URL' => 'https://whatever-bar.de/slate', 'LICENSE_KEY' => 'SLT-TEST-KEY'],
];

$updated = [];
$warnings = [];

// ── replicate the FIXED .env block ──
$envPath = $dir . '/.env';
$envExists = file_exists($envPath);
if (!$envExists) {
    if (is_writable($dir)) {
        if (@file_put_contents($envPath, "# Slate configuration — written by SLATE Master OS\n") === false) {
            $warnings[] = '.env could not be created';
        } else {
            @chmod($envPath, 0640);
            $envExists = true;
            $updated[] = '.env(created)';
        }
    } else {
        $warnings[] = '.env missing and folder not writable';
    }
}
if ($envExists && is_writable($envPath)) {
    $env = @file_get_contents($envPath);
    $map = [
        'APP_URL' => $payload['site_url'] ?? null,
        'DB_HOST' => $payload['db_host'] ?? null,
        'DB_NAME' => $payload['db_name'] ?? null,
        'DB_USER' => $payload['db_user'] ?? null,
        'DB_PASS' => $payload['db_password'] ?? null,
        'APP_BASE_PATH' => $payload['base_path'] ?? null,
    ];
    foreach (($payload['extra_env'] ?? []) as $ek => $ev) {
        $map[$ek] = $ev;
    }
    foreach ($map as $k => $v) {
        if ($v === null || $v === '') continue;
        $newLine = $k . '="' . addslashes((string)$v) . '"';
        $lines = explode("\n", $env);
        $found = false;
        foreach ($lines as $i => $ln) {
            if (preg_match('/^' . preg_quote($k, '/') . '=.*$/', rtrim($ln, "\r"))) {
                $lines[$i] = $newLine;
                $found = true;
                break;
            }
        }
        if ($found) {
            $env = implode("\n", $lines);
            $updated[] = ".env:{$k}";
        } else {
            $env = rtrim($env, "\r\n") . "\n" . $newLine;
            $updated[] = ".env:{$k}(appended)";
        }
    }
    @file_put_contents($envPath, $env);
}

// ── replicate the FIXED config.php rewrite ──
$configPath = $dir . '/config.php';
if (file_exists($configPath) && is_writable($configPath) && !empty($payload['site_url'])) {
    $cfg = @file_get_contents($configPath);
    if ($cfg !== false) {
        $newUrl = rtrim((string)$payload['site_url'], '/');
        $cfgNew = preg_replace_callback(
            "/env\s*\(\s*(['\"])APP_URL\1\s*,\s*(['\"])[^'\"]*\2\s*\)/",
            function ($m) use ($newUrl) {
                return "env('APP_URL', '" . addslashes($newUrl) . "')";
            },
            $cfg,
            -1,
            $cfgCnt
        );
        if (!empty($cfgCnt) && $cfgNew !== null) {
            if (@file_put_contents($configPath, $cfgNew) !== false) {
                $updated[] = 'config.php:SLATE_URL(' . $newUrl . ')';
                $cfg = $cfgNew;
            }
        }
        if (preg_match_all("/https?:\/\/[a-z0-9.-]+(?:\/[^'\"\s,)]*)?/i", $cfg, $m2)) {
            foreach (array_unique($m2[0]) as $found) {
                if (stripos($found, 'localhost') !== false) continue;
                $host = parse_url($found, PHP_URL_HOST) ?: '';
                $curHost = parse_url($newUrl, PHP_URL_HOST) ?: '';
                if ($host && $curHost && strcasecmp($host, $curHost) === 0) continue;
                if (preg_match('/example\.|blackbox|schemas\.|w3\.org|github\.com|slate\.dev/i', $host)) continue;
                $cfg = str_replace($found, $newUrl, $cfg);
                $updated[] = 'config.php:url(' . $host . '→' . $curHost . ')';
            }
            @file_put_contents($configPath, $cfg);
        }
    }
}

echo "=== RESULT ===\n";
echo ".env exists: " . (file_exists($envPath) ? "YES" : "NO") . "\n";
echo ".env contents:\n" . @file_get_contents($envPath) . "\n";
echo "config.php after rewrite:\n" . @file_get_contents($configPath) . "\n";
echo "updated: " . implode(', ', $updated) . "\n";
echo "warnings: " . (empty($warnings) ? '(none)' : implode(', ', $warnings)) . "\n";

$envBody = @file_get_contents($envPath);
$cfgBody = @file_get_contents($configPath);
echo "\n=== ASSERTIONS ===\n";
echo "1. .env created:                    " . (file_exists($envPath) ? "PASS" : "FAIL") . "\n";
echo "2. APP_URL is the real site:        " . (strpos($envBody, 'whatever-bar.de/slate') !== false ? "PASS" : "FAIL") . "\n";
echo "3. DB creds in .env:                " . (strpos($envBody, 'whatever_bbbe') !== false ? "PASS" : "FAIL") . "\n";
echo "4. password preserved exactly:      " . (strpos($envBody, 'p%$#8JNZuQVF#otpp7') !== false ? "PASS" : "FAIL") . "\n";
echo "5. LICENSE_KEY present:             " . (strpos($envBody, 'LICENSE_KEY') !== false ? "PASS" : "FAIL") . "\n";
echo "6. old demo URL GONE from config:   " . (strpos($cfgBody, 'greenlightinduction') === false ? "PASS" : "FAIL") . "\n";
echo "7. config.php fallback rebased:     " . (strpos($cfgBody, 'whatever-bar.de/slate') !== false ? "PASS" : "FAIL") . "\n";

array_map('unlink', glob($dir . '/*'));
rmdir($dir);
