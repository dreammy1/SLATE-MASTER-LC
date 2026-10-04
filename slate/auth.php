<?php
/**
 * SLATE DEVOPS OS - ZERO-TOUCH REMOTE AGENT (auth.php)
 * Version: 3.2.0
 *
 * Drop this file into the target remote directory (e.g. /public_html/slate/auth.php).
 * Handles:
 *  - Diagnostics & Health Checks
 *  - Master OS Handshake & Secret Pairing
 *  - Payload Deployment & Archive Unpacking
 *  - cPanel UAPI Setup & Credential Storage
 *  - MySQL Database Scanning (via cPanel UAPI)
 *  - MySQL Database Auto-Provisioning (create DB + user + grant)
 *  - MySQL Connection Probe & Testing
 *  - License Status / Key Install / Remote Enforcement (v3.1.0)
 *  - Site Overview: core version, active plugins, remote access mode (v3.2.0)
 *
 * Works across PHP 7.2 - 8.3+ and LiteSpeed / Apache / Nginx.
 * Compatible with all shared hosting cPanel environments.
 */

error_reporting(E_ALL);
ini_set('display_errors', '0');

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Slate-Token');

define('SLATE_AGENT_VERSION', '3.2.0');
define('CONFIG_FILE', __DIR__ . '/.slate_agent_config.json');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function respond($code, $data) {
    http_response_code($code);
    echo json_encode(array_merge([
        'os'        => 'SLATE_REMOTE_AGENT',
        'version'   => SLATE_AGENT_VERSION,
        'timestamp' => time()
    ], $data), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    exit;
}

set_exception_handler(function ($e) {
    respond(500, [
        'error' => $e->getMessage(),
        'file'  => basename($e->getFile()),
        'line'  => $e->getLine()
    ]);
});

// ── Pre-configured Order Fallbacks (Injected dynamically per client download) ──
$PRECONFIG_USER  = defined('SLATE_PRECONFIG_CPANEL_USER') ? SLATE_PRECONFIG_CPANEL_USER : '';
$PRECONFIG_TOKEN = defined('SLATE_PRECONFIG_HANDSHAKE_TOKEN') ? SLATE_PRECONFIG_HANDSHAKE_TOKEN : '';

function loadConfig() {
    global $PRECONFIG_USER, $PRECONFIG_TOKEN;
    $config = [];
    if (file_exists(CONFIG_FILE)) {
        $raw = @file_get_contents(CONFIG_FILE);
        $config = $raw ? (json_decode($raw, true) ?: []) : [];
    }
    if (empty($config['cpanel_user']) && !empty($PRECONFIG_USER)) {
        $config['cpanel_user'] = $PRECONFIG_USER;
    }
    if (empty($config['token_hash']) && !empty($PRECONFIG_TOKEN)) {
        $config['token_hash'] = password_hash($PRECONFIG_TOKEN, PASSWORD_DEFAULT);
    }
    return $config;
}

function saveConfig(array $config) {
    @file_put_contents(CONFIG_FILE, json_encode($config, JSON_PRETTY_PRINT));
    @chmod(CONFIG_FILE, 0600);
}

function authenticateAgent($payload) {
    $config = loadConfig();
    if (empty($config['token_hash'])) return true; // not yet paired → open
    $token = isset($_SERVER['HTTP_X_SLATE_TOKEN'])
        ? $_SERVER['HTTP_X_SLATE_TOKEN']
        : (isset($payload['token']) ? $payload['token'] : '');
    if (empty($token)) return false;
    return password_verify($token, $config['token_hash']);
}

function detectLocalCpanelUser() {
    $candidates = [];
    if (function_exists('posix_geteuid') && function_exists('posix_getpwuid')) {
        $pw = @posix_getpwuid(posix_geteuid());
        if (!empty($pw['name'])) $candidates[] = $pw['name'];
    }
    if (function_exists('get_current_user')) {
        $u = @get_current_user();
        if (!empty($u)) $candidates[] = $u;
    }
    if (!empty($_SERVER['LOGNAME'])) $candidates[] = $_SERVER['LOGNAME'];
    if (!empty($_SERVER['USER'])) $candidates[] = $_SERVER['USER'];
    if (!empty($_SERVER['DOCUMENT_ROOT'])) {
        if (preg_match('#/(?:home|home2|home3|var/chroot)/([^/]+)/#i', $_SERVER['DOCUMENT_ROOT'], $m)) {
            $candidates[] = $m[1];
        }
    }
    if (preg_match('#/(?:home|home2|home3|var/chroot)/([^/]+)/#i', __DIR__, $m)) {
        $candidates[] = $m[1];
    }
    foreach ($candidates as $cand) {
        $cand = trim((string)$cand);
        if ($cand !== '' && $cand !== 'root' && $cand !== 'nobody' && $cand !== 'apache' && $cand !== 'www-data' && $cand !== 'nginx') {
            return $cand;
        }
    }
    return '';
}

/**
 * Call cPanel UAPI with multi-layered connection fallbacks:
 * 1. CLI /usr/bin/uapi (local binary if exec enabled, zero port dependency, no token required locally)
 * 2. HTTPS 127.0.0.1:2083
 * 3. HTTPS localhost:2083
 * 4. HTTPS {domain}:2083
 * 5. HTTP 127.0.0.1:2082
 * 6. HTTP localhost:2082
 * 7. HTTP {domain}:2082
 */
function cpanelUapi($module, $func, array $params = [], $config = null) {
    if ($config === null) $config = loadConfig();

    $cpUser  = isset($config['cpanel_user']) ? trim($config['cpanel_user']) : '';
    if (empty($cpUser)) {
        $cpUser = detectLocalCpanelUser();
    }
    $cpToken = isset($config['cpanel_api_token']) ? trim($config['cpanel_api_token']) : '';

    // ── Strategy 1: Native CLI `uapi` binary ─────────────────────────────────
    $disabled = array_map('trim', explode(',', (string)ini_get('disable_functions')));
    if (function_exists('exec') && !in_array('exec', $disabled)) {
        $uapiBins = ['/usr/bin/uapi', '/usr/local/cpanel/bin/uapi', 'uapi'];
        $foundBin = null;
        foreach ($uapiBins as $bin) {
            if ($bin === 'uapi' || is_executable($bin)) {
                $foundBin = $bin;
                break;
            }
        }

        if ($foundBin) {
            $cliArgs = [];
            foreach ($params as $k => $v) {
                // cPanel CLI expects spaces to be encoded as %20
                $encodedVal = str_replace(' ', '%20', (string)$v);
                $cliArgs[] = escapeshellarg("{$k}={$encodedVal}");
            }
            // CRITICAL: When PHP runs under LiteSpeed/lsapi/suPHP/php-fpm as the cPanel account user,
            // passing `--user` is strictly FORBIDDEN by cPanel ("The --user flag is only permitted when running as root").
            // Executing `uapi` WITHOUT `--user` executes natively and immediately as the current user,
            // requiring zero credentials and bypassing port 2083 firewall restrictions!
            $commandsToTry = [
                "{$foundBin} " . escapeshellarg($module) . " " . escapeshellarg($func) . " " . implode(' ', $cliArgs) . " --output=json 2>&1"
            ];
            if (!empty($cpUser)) {
                $commandsToTry[] = "{$foundBin} --user=" . escapeshellarg($cpUser) . " " . escapeshellarg($module) . " " . escapeshellarg($func) . " " . implode(' ', $cliArgs) . " --output=json 2>&1";
            }

            foreach ($commandsToTry as $cmd) {
                $cliOut = [];
                $cliRet = -1;
                @exec($cmd, $cliOut, $cliRet);
                if ($cliRet === 0 && !empty($cliOut)) {
                    $rawJson = implode("\n", $cliOut);
                    $parsed = json_decode($rawJson, true);
                    if (is_array($parsed)) {
                        if (isset($parsed['status']) && (int)$parsed['status'] === 1) {
                            return $parsed['data'] ?? $parsed;
                        }
                        if (isset($parsed['result']['status']) && (int)$parsed['result']['status'] === 1) {
                            return $parsed['result']['data'] ?? $parsed;
                        }
                    }
                }
            }
        }
    }

    if (empty($cpUser) || empty($cpToken)) {
        throw new Exception('cPanel credentials not configured and local CLI uapi unavailable.');
    }

    // ── Strategy 2: REST cPanel UAPI via cURL ────────────────────────────────
    if (!extension_loaded('curl')) {
        throw new Exception('cURL PHP extension is required for cPanel UAPI calls.');
    }

    $currentHost = !empty($_SERVER['HTTP_HOST']) ? preg_replace('/:[0-9]+$/', '', $_SERVER['HTTP_HOST']) : '';
    if (empty($currentHost) && !empty($_SERVER['SERVER_NAME'])) {
        $currentHost = $_SERVER['SERVER_NAME'];
    }

    $endpoints = [
        "https://127.0.0.1:2083/execute/{$module}/{$func}",
        "https://localhost:2083/execute/{$module}/{$func}",
    ];
    if ($currentHost && $currentHost !== 'localhost' && $currentHost !== '127.0.0.1') {
        $endpoints[] = "https://{$currentHost}:2083/execute/{$module}/{$func}";
    }
    $endpoints[] = "http://127.0.0.1:2082/execute/{$module}/{$func}";
    $endpoints[] = "http://localhost:2082/execute/{$module}/{$func}";
    if ($currentHost && $currentHost !== 'localhost' && $currentHost !== '127.0.0.1') {
        $endpoints[] = "http://{$currentHost}:2082/execute/{$module}/{$func}";
    }

    $lastHttpCode = 0;
    $lastError    = '';
    $lastRawBody  = '';

    // Support both API Tokens ("Authorization: cpanel user:token") and
    // account passwords ("Authorization: Basic base64(user:password)").
    $authHeaderVariants = [
        "Authorization: cpanel {$cpUser}:{$cpToken}",
        "Authorization: Basic " . base64_encode("{$cpUser}:{$cpToken}"),
    ];

    foreach ($endpoints as $url) {
        foreach ($authHeaderVariants as $authHdr) {
            $ch = curl_init();
            curl_setopt_array($ch, [
                CURLOPT_URL            => $url,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_SSL_VERIFYPEER => false,
                CURLOPT_SSL_VERIFYHOST => false,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_MAXREDIRS      => 3,
                CURLOPT_TIMEOUT        => 25,
                CURLOPT_CONNECTTIMEOUT => 4,
                CURLOPT_HTTPHEADER     => [
                    $authHdr,
                    'Content-Type: application/x-www-form-urlencoded',
                    'User-Agent: SLATE-DevOps-Agent/3.0.0',
                ],
                CURLOPT_POST           => !empty($params),
                CURLOPT_POSTFIELDS     => http_build_query($params, '', '&', PHP_QUERY_RFC3986),
            ]);

            $body     = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $curlErr  = curl_error($ch);
            curl_close($ch);

            if ($curlErr) {
                $lastError = "{$url}: {$curlErr}";
                continue;
            }

            $lastHttpCode = $httpCode;
            $lastRawBody  = $body;

            // HTML response means auth was rejected for this header format; try next auth header
            $trimmed = trim((string)$body);
            if (preg_match('/^<(!doctype\s+html|html[\s>])/i', $trimmed)) {
                continue;
            }

            if ($httpCode === 401) {
                continue;
            }

            $result = json_decode((string)$body, true);
            if (is_array($result)) {
                if (isset($result['status']) && (int)$result['status'] === 0) {
                    $errs = !empty($result['errors']) ? (is_array($result['errors']) ? implode('; ', $result['errors']) : $result['errors']) : 'cPanel error';
                    throw new Exception("cPanel UAPI error: {$errs}");
                }
                if (isset($result['result']['status']) && (int)$result['result']['status'] === 0) {
                    $errs = !empty($result['result']['errors']) ? implode('; ', (array)$result['result']['errors']) : 'cPanel error';
                    throw new Exception("cPanel UAPI error: {$errs}");
                }
                return $result['data'] ?? $result['result']['data'] ?? $result;
            }
        }
    }

    $snippet = substr(trim(strip_tags((string)$lastRawBody)), 0, 160);
    $extra = $snippet ? " [Response: {$snippet}]" : "";
    $diag = $lastError ? " [Last error: {$lastError}]" : "";
    throw new Exception("cPanel UAPI unreachable or returned non-JSON (HTTP {$lastHttpCode}).{$extra}{$diag} Verify port 2083 is accessible and cPanel API Token or hosting password has MySQL privileges.");
}

/** Generate a cryptographically strong random password meeting cPanel 80+ score */
function generatePassword($length = 20) {
    $alphaUpper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    $alphaLower = 'abcdefghijkmnopqrstuvwxyz';
    $numbers    = '23456789';
    $symbols    = '!@#$%*-_=+';
    $all = $alphaUpper . $alphaLower . $numbers . $symbols;

    $pass = [
        $alphaUpper[random_int(0, strlen($alphaUpper) - 1)],
        $alphaLower[random_int(0, strlen($alphaLower) - 1)],
        $numbers[random_int(0, strlen($numbers) - 1)],
        $symbols[random_int(0, strlen($symbols) - 1)],
    ];

    for ($i = count($pass); $i < $length; $i++) {
        $pass[] = $all[random_int(0, strlen($all) - 1)];
    }

    shuffle($pass);
    return implode('', $pass);
}

/** Sanitize a string to a valid MySQL identifier suffix (max 8 chars) */
function sanitizeDbName($str, $max = 8) {
    $clean = preg_replace('/[^a-zA-Z0-9_]/', '', strtolower($str));
    return substr($clean, 0, $max);
}

// ── Parse request ─────────────────────────────────────────────────────────────

$rawInput = file_get_contents('php://input');
$payload  = json_decode($rawInput, true);
if (!is_array($payload)) $payload = $_POST;

// Canonical supported actions in THIS agent release. Keep in sync with the
// individual if-blocks below. Used for diagnostics → stale-agent detection.
$SLATE_SUPPORTED_ACTIONS = [
    'diagnostics','ping','handshake','cpanel_setup',
    'database_scan','database_create','database_probe',
    'deploy','package_files','download_package',
    'dump_database','sql_import','write_config',
    'license_status','license_set_key','license_enforce',
    'site_overview',
];

// Parse action: URL query string > $_POST['action'] (multipart/form-data)
//              > JSON body payload['action'] > default 'diagnostics'.
// NOTE: We read $_POST['action'] explicitly because when json_decode($rawInput)
//       fails on a multipart body, PHP fills $_POST for form fields but if
//       Content-Type boundary is non-standard the fallback may miss them. This
//       four-step fallback matches the Master Executor's new behaviour of
//       always sending ?action=NAME query param as a belt-and-braces approach.
$action = 'diagnostics';
if (!empty($_GET['action'])) {
    $action = (string)$_GET['action'];
} elseif (!empty($_POST['action'])) {
    $action = (string)$_POST['action'];
} elseif (is_array($payload) && !empty($payload['action'])) {
    $action = (string)$payload['action'];
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. DIAGNOSTICS & CAPABILITY PROBE
// ═════════════════════════════════════════════════════════════════════════════
if ($action === 'diagnostics' || $action === 'ping') {
    $config     = loadConfig();
    $writable   = is_writable(__DIR__);
    $pdoMySql   = extension_loaded('pdo_mysql');
    $zipEnabled = class_exists('ZipArchive');
    $curlEnabled = extension_loaded('curl');
    $phpVersion = PHP_VERSION;

    $detectedUser = !empty($config['cpanel_user']) ? $config['cpanel_user'] : detectLocalCpanelUser();
    respond(200, [
        'status'          => ($writable && version_compare($phpVersion, '7.2.0', '>=')) ? 'READY' : 'DEGRADED',
        'configured'      => file_exists(CONFIG_FILE),
        'cpanel_linked'   => !empty($config['cpanel_user']) || !empty($detectedUser),
        'cpanel_user'     => $detectedUser ?: null,
        'agent_version'   => SLATE_AGENT_VERSION,
        'agent_release'   => 'SLATE-DEVOPS-OS-' . SLATE_AGENT_VERSION,
        'supported_actions' => $GLOBALS['SLATE_SUPPORTED_ACTIONS'] ?? $SLATE_SUPPORTED_ACTIONS,
        'capabilities'    => [
            'php_version'       => $phpVersion,
            'directory_writable' => $writable,
            'zip_archive'       => $zipEnabled,
            'pdo_mysql'         => $pdoMySql,
            'curl'              => $curlEnabled,
            'target_path'       => __DIR__,
            'memory_limit'      => ini_get('memory_limit'),
            'max_upload'        => ini_get('upload_max_filesize'),
            'disk_free_mb'      => ($df = @disk_free_space(__DIR__)) !== false ? round($df / 1048576, 2) : 'unknown',
        ],
        'server_software' => $_SERVER['SERVER_SOFTWARE'] ?? 'Unknown',
    ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. MASTER OS HANDSHAKE
// ═════════════════════════════════════════════════════════════════════════════
if ($action === 'handshake') {
    $token      = trim($payload['token'] ?? '');
    $masterHost = trim($payload['master_host'] ?? '');

    if (empty($token) || strlen($token) < 16) {
        respond(400, ['error' => 'Invalid or missing handshake token (min 16 chars).']);
    }

    $config = loadConfig();
    $config['token_hash']  = password_hash($token, PASSWORD_DEFAULT);
    $config['master_host'] = $masterHost;
    $config['registered_at'] = date('c');
    $config['path']        = __DIR__;
    saveConfig($config);

    respond(200, [
        'status'  => 'REGISTERED',
        'message' => 'Remote agent synchronized with SLATE Master OS successfully.',
    ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. CPANEL CREDENTIALS SETUP  (one-time)
// ═════════════════════════════════════════════════════════════════════════════
if ($action === 'cpanel_setup') {
    if (!authenticateAgent($payload)) {
        respond(401, ['error' => 'Unauthorized. Invalid X-Slate-Token.']);
    }

    $cpUser  = trim($payload['cpanel_user']      ?? '');
    $cpToken = trim($payload['cpanel_api_token'] ?? '');

    if (empty($cpUser) || empty($cpToken)) {
        respond(400, ['error' => 'Both cpanel_user and cpanel_api_token are required.']);
    }

    // Validate immediately by listing databases
    $config = loadConfig();
    $config['cpanel_user']      = $cpUser;
    $config['cpanel_api_token'] = $cpToken;
    saveConfig($config);

    try {
        $testData = cpanelUapi('Mysql', 'list_databases', [], $config);
        $dbCount  = is_array($testData) ? count($testData) : '?';
        respond(200, [
            'status'       => 'CPANEL_LINKED',
            'cpanel_user'  => $cpUser,
            'db_count'     => $dbCount,
            'message'      => "cPanel credentials verified. Found {$dbCount} existing database(s).",
        ]);
    } catch (Exception $e) {
        // Save credentials anyway (might work later), but report the error
        respond(200, [
            'status'      => 'CPANEL_SAVED',
            'cpanel_user' => $cpUser,
            'warning'     => 'Credentials saved but live verification failed: ' . $e->getMessage(),
            'message'     => 'Credentials stored. If verification failed, check the API Token in cPanel → Security → API Tokens.',
        ]);
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. DATABASE SCAN — list all existing MySQL databases & users
// ═════════════════════════════════════════════════════════════════════════════
if ($action === 'database_scan') {
    if (!authenticateAgent($payload)) {
        respond(401, ['error' => 'Unauthorized. Invalid X-Slate-Token.']);
    }

    $dbs   = cpanelUapi('Mysql', 'list_databases');
    $users = cpanelUapi('Mysql', 'list_users');

    // list_databases returns array of { database, diskusage }
    $databases = [];
    if (is_array($dbs)) {
        foreach ($dbs as $db) {
            if (is_array($db)) {
                $databases[] = [
                    'name'     => $db['database'] ?? $db,
                    'size_mb'  => isset($db['diskusage']) ? round($db['diskusage'] / 1048576, 2) : null,
                ];
            } else {
                $databases[] = ['name' => $db, 'size_mb' => null];
            }
        }
    }

    $userList = [];
    if (is_array($users)) {
        foreach ($users as $u) {
            $userList[] = is_array($u) ? ($u['user'] ?? $u) : $u;
        }
    }

    respond(200, [
        'status'    => 'OK',
        'databases' => $databases,
        'users'     => $userList,
        'counts'    => ['databases' => count($databases), 'users' => count($userList)],
    ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. DATABASE CREATE — auto-provision DB + user + privileges
// ═════════════════════════════════════════════════════════════════════════════
if ($action === 'database_create') {
    if (!authenticateAgent($payload)) {
        respond(401, ['error' => 'Unauthorized. Invalid X-Slate-Token.']);
    }

    $config  = loadConfig();
    $cpUser  = trim((string)($payload['cpanel_user'] ?? $config['cpanel_user'] ?? ''));
    if (empty($cpUser)) {
        $cpUser = detectLocalCpanelUser();
    }
    $cpToken = trim((string)($payload['cpanel_api_token'] ?? $config['cpanel_api_token'] ?? ''));
    if (!empty($cpUser))  $config['cpanel_user'] = $cpUser;
    if (!empty($cpToken)) $config['cpanel_api_token'] = $cpToken;
    if (!empty($cpUser) || !empty($cpToken)) saveConfig($config);

    $appName = sanitizeDbName($payload['app_name'] ?? 'app', 4);
    $suffix  = sanitizeDbName(bin2hex(random_bytes(3)), 6);

    $dbSuffix   = $suffix;
    $userSuffix = 'u' . substr($suffix, 0, 4);
    $fullDbName   = ($cpUser ? $cpUser . '_' : '') . $dbSuffix;
    $fullUserName = ($cpUser ? $cpUser . '_' : '') . $userSuffix;
    $password = generatePassword(18);

    $steps = [];
    $uapiError = null;

    // ── Strategy A: cPanel UAPI (CLI or REST) ──────────────────────────────
    try {
        // Try creating DB
        try {
            cpanelUapi('Mysql', 'create_database', ['name' => $dbSuffix], $config);
            $steps[] = ['step' => 'create_database', 'status' => 'OK', 'name' => $fullDbName];
        } catch (Exception $e) {
            cpanelUapi('Mysql', 'create_database', ['name' => $fullDbName], $config);
            $steps[] = ['step' => 'create_database', 'status' => 'OK', 'name' => $fullDbName, 'mode' => 'full_prefix'];
        }

        // Try creating user
        try {
            cpanelUapi('Mysql', 'create_user', ['name' => $userSuffix, 'password' => $password], $config);
            $steps[] = ['step' => 'create_user', 'status' => 'OK', 'user' => $fullUserName];
        } catch (Exception $e) {
            cpanelUapi('Mysql', 'create_user', ['name' => $fullUserName, 'password' => $password], $config);
            $steps[] = ['step' => 'create_user', 'status' => 'OK', 'user' => $fullUserName, 'mode' => 'full_prefix'];
        }

        // Try granting privileges
        $privilegeVariants = [
            'ALL PRIVILEGES',
            'ALL',
            'ALTER,CREATE,DELETE,DROP,INDEX,INSERT,SELECT,UPDATE,REFERENCES',
        ];
        $granted = false;
        foreach ($privilegeVariants as $priv) {
            try {
                cpanelUapi('Mysql', 'set_privileges_on_database', [
                    'user'       => $fullUserName,
                    'database'   => $fullDbName,
                    'privileges' => $priv,
                ], $config);
                $steps[] = ['step' => 'grant_privileges', 'status' => 'OK', 'format' => $priv];
                $granted = true;
                break;
            } catch (Exception $e) {
                // try next variant
            }
        }

        respond(200, [
            'status'      => 'PROVISIONED',
            'message'     => 'Database and user provisioned automatically via cPanel UAPI.',
            'credentials' => [
                'db_name'     => $fullDbName,
                'db_user'     => $fullUserName,
                'db_password' => $password,
                'db_host'     => 'localhost',
                'db_port'     => 3306,
            ],
            'steps' => $steps,
        ]);
    } catch (Exception $uapiEx) {
        $uapiError = $uapiEx->getMessage();
        $steps[] = ['step' => 'cpanel_uapi_attempt', 'status' => 'FAILED', 'error' => $uapiError];
    }

    // ── Strategy B: Auto-Discovery & Direct MySQL PDO Fallback ─────────────
    $discovered = discoverDbCredentials(__DIR__);
    if (!empty($discovered['db_name']) && !empty($discovered['db_user'])) {
        $dHost = !empty($discovered['db_host']) ? $discovered['db_host'] : 'localhost';
        $dUser = $discovered['db_user'];
        $dPass = $discovered['db_pass'] ?? '';
        $dName = $discovered['db_name'];
        $src   = $discovered['source'] ?? 'environment';

        // Connect via PDO to verify credentials and try to create dedicated DB or adopt existing DB
        if (extension_loaded('pdo_mysql')) {
            try {
                $h = preg_replace('/:[0-9]+$/', '', (string)$dHost) ?: 'localhost';
                $pdo = new PDO("mysql:host={$h};charset=utf8mb4", $dUser, $dPass, [
                    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_TIMEOUT => 4,
                ]);

                // Try to create a dedicated slate database first
                $newDb = ($cpUser ? $cpUser . '_' : '') . 'slate_' . substr(bin2hex(random_bytes(3)), 0, 6);
                try {
                    $pdo->exec("CREATE DATABASE IF NOT EXISTS `{$newDb}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
                    respond(200, [
                        'status'      => 'PROVISIONED',
                        'message'     => "Created dedicated database `{$newDb}` using verified MySQL connection from {$src}.",
                        'credentials' => [
                            'db_name'     => $newDb,
                            'db_user'     => $dUser,
                            'db_password' => $dPass,
                            'db_host'     => $dHost,
                            'db_port'     => 3306,
                        ],
                        'steps' => array_merge($steps, [['step' => 'created_dedicated_db', 'status' => 'OK', 'name' => $newDb]]),
                    ]);
                } catch (\Throwable $createEx) {
                    // Cannot CREATE DATABASE (normal for shared hosting user).
                    // Seamlessly adopt existing database!
                    respond(200, [
                        'status'      => 'PROVISIONED',
                        'message'     => "Connected and adopted database `{$dName}` from {$src}.",
                        'credentials' => [
                            'db_name'     => $dName,
                            'db_user'     => $dUser,
                            'db_password' => $dPass,
                            'db_host'     => $dHost,
                            'db_port'     => 3306,
                        ],
                        'steps' => array_merge($steps, [['step' => 'adopted_existing_db', 'status' => 'OK', 'name' => $dName]]),
                    ]);
                }
            } catch (\Throwable $connEx) {
                // Return discovered credentials even if direct connection timed out
                respond(200, [
                    'status'      => 'PROVISIONED',
                    'message'     => "Discovered credentials for database `{$dName}` from {$src}.",
                    'credentials' => [
                        'db_name'     => $dName,
                        'db_user'     => $dUser,
                        'db_password' => $dPass,
                        'db_host'     => $dHost,
                        'db_port'     => 3306,
                    ],
                    'steps' => array_merge($steps, [['step' => 'discovered_db_fallback', 'status' => 'OK', 'name' => $dName]]),
                ]);
            }
        } else {
            respond(200, [
                'status'      => 'PROVISIONED',
                'message'     => "Discovered database `{$dName}` from {$src}.",
                'credentials' => [
                    'db_name'     => $dName,
                    'db_user'     => $dUser,
                    'db_password' => $dPass,
                    'db_host'     => $dHost,
                    'db_port'     => 3306,
                ],
                'steps' => array_merge($steps, [['step' => 'discovered_db_fallback', 'status' => 'OK', 'name' => $dName]]),
            ]);
        }
    }

    // ── Strategy C: Local default connection (dev / root / cpUser without pass) ───
    if (extension_loaded('pdo_mysql')) {
        $candidateLogins = [
            ['user' => 'root', 'pass' => ''],
            ['user' => $cpUser, 'pass' => ''],
        ];
        foreach ($candidateLogins as $cl) {
            if (empty($cl['user'])) continue;
            try {
                $pdo = new PDO("mysql:host=localhost;charset=utf8mb4", $cl['user'], $cl['pass'], [
                    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_TIMEOUT => 2,
                ]);
                $newDb = ($cpUser ? $cpUser . '_' : '') . 'slate_' . substr(bin2hex(random_bytes(3)), 0, 6);
                $pdo->exec("CREATE DATABASE IF NOT EXISTS `{$newDb}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
                respond(200, [
                    'status'      => 'PROVISIONED',
                    'message'     => "Created database `{$newDb}` via local MySQL connection.",
                    'credentials' => [
                        'db_name'     => $newDb,
                        'db_user'     => $cl['user'],
                        'db_password' => $cl['pass'],
                        'db_host'     => 'localhost',
                        'db_port'     => 3306,
                    ],
                    'steps' => array_merge($steps, [['step' => 'local_mysql_provision', 'status' => 'OK', 'name' => $newDb]]),
                ]);
            } catch (\Throwable $e) {
                // continue to next candidate
            }
        }
    }

    respond(500, [
        'error' => "Automated database provisioning failed: " . ($uapiError ?: 'cPanel credentials not configured and local CLI uapi unavailable.') . " Please verify cPanel API Token or provide MySQL credentials.",
        'steps' => $steps,
    ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. DATABASE PROBE — test a MySQL connection with given credentials
// ═════════════════════════════════════════════════════════════════════════════
if ($action === 'database_probe') {
    if (!authenticateAgent($payload)) {
        respond(401, ['error' => 'Unauthorized. Invalid X-Slate-Token.']);
    }

    if (!extension_loaded('pdo_mysql')) {
        respond(500, ['error' => 'PDO MySQL extension is not enabled on this server.']);
    }

    $dbName = $payload['db_name'] ?? '';
    $dbUser = $payload['db_user'] ?? '';
    $dbPass = $payload['db_password'] ?? '';
    $dbHost = $payload['db_host'] ?? 'localhost';
    $dbPort = (int)($payload['db_port'] ?? 3306);

    if (empty($dbName) || empty($dbUser)) {
        respond(400, ['error' => 'db_name and db_user are required for probe.']);
    }

    try {
        $dsn = "mysql:host={$dbHost};port={$dbPort};dbname={$dbName};charset=utf8mb4";
        $pdo = new PDO($dsn, $dbUser, $dbPass, [
            PDO::ATTR_TIMEOUT            => 5,
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);

        // Get table count and DB size
        $tableCount = (int)$pdo->query(
            "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()"
        )->fetchColumn();

        $sizeRow = $pdo->query(
            "SELECT ROUND(SUM(data_length + index_length) / 1048576, 2) AS size_mb
             FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE()"
        )->fetch();

        $sizeMb = $sizeRow['size_mb'] ?? 0;
        $version = $pdo->query('SELECT VERSION()')->fetchColumn();

        respond(200, [
            'status'       => 'CONNECTED',
            'db_name'      => $dbName,
            'db_host'      => $dbHost,
            'table_count'  => $tableCount,
            'size_mb'      => (float)$sizeMb,
            'mysql_version' => $version,
        ]);
    } catch (PDOException $e) {
        respond(200, [
            'status' => 'FAILED',
            'error'  => $e->getMessage(),
        ]);
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. ZERO-TOUCH PAYLOAD DEPLOYMENT
// ═════════════════════════════════════════════════════════════════════════════
if ($action === 'deploy') {
    if (!authenticateAgent($payload)) {
        respond(401, ['error' => 'Unauthorized. Invalid X-Slate-Token.']);
    }

    $zipData = null;
    if (isset($_FILES['archive']) && $_FILES['archive']['error'] === UPLOAD_ERR_OK) {
        $zipData = file_get_contents($_FILES['archive']['tmp_name']);
    } elseif (!empty($payload['archive_base64'])) {
        $zipData = base64_decode($payload['archive_base64']);
    }

    if (!$zipData) {
        respond(400, ['error' => 'No deployment archive received (archive or archive_base64 required).']);
    }

    $tempZip = __DIR__ . '/.slate_deploy_' . time() . '.zip';
    if (!@file_put_contents($tempZip, $zipData)) {
        respond(500, ['error' => 'Failed to write temporary archive. Check folder permissions.']);
    }

    if (!class_exists('ZipArchive')) {
        @unlink($tempZip);
        respond(500, ['error' => 'PHP ZipArchive extension is not enabled.']);
    }

    $zip = new ZipArchive();
    if ($zip->open($tempZip) !== true) {
        @unlink($tempZip);
        respond(500, ['error' => 'Failed to open deployment zip package.']);
    }

    $extracted = 0;
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $filename = $zip->getNameIndex($i);
        if (strpos($filename, '../') !== false || strpos($filename, '..' . DIRECTORY_SEPARATOR) !== false) continue;
        if ($filename === 'auth.php' && empty($payload['allow_agent_upgrade']) && empty($_POST['allow_agent_upgrade'])) continue; // protect agent unless explicit upgrade
        $zip->extractTo(__DIR__, $filename);
        $extracted++;
    }
    $zip->close();
    @unlink($tempZip);

    if (function_exists('opcache_reset')) @opcache_reset();

    respond(200, [
        'status'          => 'DEPLOYED',
        'message'         => 'Deployment applied successfully.',
        'files_extracted' => $extracted,
        'deployed_at'     => date('c'),
        'commit'          => $payload['commit_sha'] ?? 'HEAD',
    ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// 8. PACKAGE FILES — Zip the agent directory (or sub-path) into a downloadable archive
// ═════════════════════════════════════════════════════════════════════════════
if ($action === 'package_files') {
    if (!authenticateAgent($payload)) {
        respond(401, ['error' => 'Unauthorized. Invalid X-Slate-Token.']);
    }

    if (!class_exists('ZipArchive')) {
        respond(500, ['error' => 'PHP ZipArchive extension is not enabled on the source server.']);
    }

    $subPath    = isset($payload['sub_path']) ? trim((string)$payload['sub_path']) : '';
    $baseDir    = realpath(__DIR__);
    $targetDir  = $baseDir;
    if ($subPath !== '' && $subPath !== '.') {
        $candidate = realpath($baseDir . '/' . $subPath);
        if ($candidate && strpos($candidate, $baseDir) === 0 && is_dir($candidate)) {
            $targetDir = $candidate;
        }
    }

    $tokenSuffix = substr(md5(uniqid((string)mt_rand(), true)), 0, 8);
    $zipPath = __DIR__ . '/.slate_pkg_' . time() . '_' . $tokenSuffix . '.zip';

    $zip = new ZipArchive();
    if ($zip->open($zipPath, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
        @unlink($zipPath);
        respond(500, ['error' => 'Failed to create temporary package archive on source server.']);
    }

    $excludes = [
        basename($zipPath),
        'auth.php',
        '.slate_agent_config.json',
        '.slate_deploy_',
        '.slate_pkg_',
        '.slate_dump_',
        '.slate_import_',
        '.git',
        '.svn',
        'node_modules',
        'vendor',
        'error_log',
    ];

    $fileCount = 0;
    $totalSize = 0;

    $iterator = new RecursiveIteratorIterator(
        new RecursiveCallbackFilterIterator(
            new RecursiveDirectoryIterator($targetDir, FilesystemIterator::SKIP_DOTS | FilesystemIterator::UNIX_PATHS),
            function ($current) use ($excludes, $zipPath) {
                $name = $current->getFilename();
                foreach ($excludes as $ex) {
                    if ($name === $ex || strpos($name, $ex) === 0) {
                        return false;
                    }
                }
                if ($current->getPathname() === $zipPath) return false;
                return true;
            }
        ),
        RecursiveIteratorIterator::SELF_FIRST
    );

    foreach ($iterator as $item) {
        if ($item->isDir()) continue;
        $absPath = $item->getPathname();
        $relPath = ltrim(substr($absPath, strlen($targetDir)), '/\\');
        if ($relPath === '' || $relPath === 'auth.php' || $relPath === '.slate_agent_config.json') continue;
        if (strpos($relPath, '.slate_') === 0) continue;
        if (@$zip->addFile($absPath, $relPath)) {
            $fileCount++;
            $totalSize += $item->getSize();
        }
    }
    $zip->close();

    if ($fileCount === 0) {
        @unlink($zipPath);
        respond(500, ['error' => 'Source directory contains no packageable files, or ZipArchive addFile failed. Check folder read permissions.']);
    }

    $finalSize = @filesize($zipPath);
    $downloadToken = 'slate_dl_' . $tokenSuffix;
    $config = loadConfig();
    if (!is_array($config)) $config = [];
    $config['pending_downloads'][$downloadToken] = [
        'path'      => $zipPath,
        'size'      => $finalSize,
        'file_count'=> $fileCount,
        'expires'   => time() + 900,
        'type'      => 'zip',
    ];
    saveConfig($config);

    respond(200, [
        'status'     => 'PACKAGED',
        'message'    => "Source directory packaged successfully ({$fileCount} files, ~" . round($finalSize / 1048576, 2) . " MB).",
        'files'      => $fileCount,
        'size_bytes' => $finalSize,
        'size_mb'    => round($finalSize / 1048576, 2),
        'download_token' => $downloadToken,
        'download_url'   => (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on' ? 'https' : 'http')
            . '://' . ($_SERVER['HTTP_HOST'] ?? $_SERVER['SERVER_NAME'] ?? 'localhost')
            . ($_SERVER['REQUEST_URI'] ? parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) : '/auth.php')
            . '?action=download_package&token=' . urlencode($downloadToken),
    ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// 8b. DOWNLOAD PACKAGE — Stream a previously packaged zip/dump file to caller
// ═════════════════════════════════════════════════════════════════════════════
if ($action === 'download_package') {
    $token = trim($_GET['token'] ?? ($payload['token'] ?? ''));
    if ($token === '') {
        respond(400, ['error' => 'Missing download_token.']);
    }
    $config = loadConfig();
    $pending = $config['pending_downloads'][$token] ?? null;
    if (!$pending) {
        respond(404, ['error' => 'Download token not found or expired. Re-run package_files/dump_database.']);
    }
    if (!empty($pending['expires']) && (int)$pending['expires'] < time()) {
        unset($config['pending_downloads'][$token]);
        saveConfig($config);
        respond(410, ['error' => 'Download token expired. Please re-run packaging step.']);
    }
    $filePath = $pending['path'];
    if (!file_exists($filePath)) {
        unset($config['pending_downloads'][$token]);
        saveConfig($config);
        respond(404, ['error' => 'Package file no longer exists on source server (purged).']);
    }

    $isSql = ($pending['type'] ?? 'zip') === 'sql';
    header('Content-Type: ' . ($isSql ? 'application/octet-stream' : 'application/zip'));
    header('Content-Disposition: attachment; filename="slate_' . $token . ($isSql ? '.sql' : '.zip') . '"');
    header('Content-Length: ' . filesize($filePath));
    header('Accept-Ranges: bytes');
    header('X-Accel-Buffering: no');
    session_write_close();

    $chunksize = 8 * 1024 * 1024;
    $handle = fopen($filePath, 'rb');
    if ($handle === false) {
        respond(500, ['error' => 'Failed to open package file for streaming.']);
    }
    while (!feof($handle)) {
        echo fread($handle, $chunksize);
        flush();
        @ob_flush();
    }
    fclose($handle);

    @unlink($filePath);
    unset($config['pending_downloads'][$token]);
    saveConfig($config);
    exit;
}

// ═════════════════════════════════════════════════════════════════════════════
// 9. DUMP DATABASE — Run mysqldump and return a download token for the .sql
// ═════════════════════════════════════════════════════════════════════════════
if ($action === 'dump_database') {
    if (!authenticateAgent($payload)) {
        respond(401, ['error' => 'Unauthorized. Invalid X-Slate-Token.']);
    }

    $config = loadConfig();
    $dbHost = trim($payload['db_host'] ?? 'localhost');
    $dbPort = (int)($payload['db_port'] ?? 3306);
    $dbName = trim($payload['db_name'] ?? '');
    $dbUser = trim($payload['db_user'] ?? ($config['cpanel_user'] ?? ''));
    $dbPass = $payload['db_password'] ?? '';

    if ($dbName === '' || $dbUser === '') {
        // Try to read from wp-config.php or .env if present
        $discovered = discoverDbCredentials(__DIR__);
        if ($dbName === '' && !empty($discovered['db_name'])) $dbName = $discovered['db_name'];
        if ($dbUser === '' && !empty($discovered['db_user'])) $dbUser = $discovered['db_user'];
        if ($dbPass === '' && !empty($discovered['db_pass'])) $dbPass = $discovered['db_pass'];
        if ($dbHost === 'localhost' && !empty($discovered['db_host'])) $dbHost = $discovered['db_host'];

        if ($dbName === '' || $dbUser === '') {
            respond(400, ['error' => 'db_name and db_user are required for dump. Alternatively, pass cpanel_setup credentials or have a wp-config.php/.env in the agent directory.']);
        }
    }

    $tokenSuffix = substr(md5(uniqid((string)mt_rand(), true)), 0, 8);
    $dumpPath = __DIR__ . '/.slate_dump_' . time() . '_' . $tokenSuffix . '.sql';

    $dumpSuccess = false;
    $dumpError = '';

    // Strategy A: shell mysqldump binary (fastest, preferred)
    $disabled = array_map('trim', explode(',', (string)ini_get('disable_functions')));
    if (function_exists('exec') && !in_array('exec', $disabled) && !in_array('shell_exec', $disabled)) {
        $mysqldumpBins = ['/usr/bin/mysqldump', '/usr/local/bin/mysqldump', 'mysqldump'];
        $foundBin = null;
        foreach ($mysqldumpBins as $bin) {
            if ($bin === 'mysqldump') { $foundBin = $bin; break; }
            if (is_executable($bin)) { $foundBin = $bin; break; }
        }
        if ($foundBin) {
            $escUser = escapeshellarg($dbUser);
            $escPass = escapeshellarg($dbPass);
            $escHost = escapeshellarg($dbHost);
            $escPort = (int)$dbPort;
            $escDb   = escapeshellarg($dbName);
            $escOut  = escapeshellarg($dumpPath);
            $errLog  = $dumpPath . '.stderr.log';
            $escErr  = escapeshellarg($errLog);

            // NOTE: stderr goes to SEPARATE file $errLog so that deprecation warnings (MariaDB 10.6+:
            //   "/usr/bin/mysqldump: Deprecated program name. Use mariadb-dump instead" ...)
            // or GTID-purged warnings, table-lock notices, etc NEVER merge into the SQL dump
            // (previously 2>&1 merged stderr onto stdout → first line of .sql was garbage → 1064 syntax).
            // stdout (the real dump) → $dumpPath exclusively.
            $cmd = "{$foundBin} --user={$escUser} --password={$escPass} --host={$escHost} --port={$escPort}"
                 . " --single-transaction --quick --lock-tables=false --default-character-set=utf8mb4"
                 . " --column-statistics=0 --no-tablespaces"
                 . " --routines --triggers --events {$escDb}"
                 . " > {$escOut} 2>{$escErr}";
            @exec($cmd, $outArr, $ret);

            // Always try mariadb-dump alias if mysqldump binary itself emitted deprecation + non-zero
            // exit OR produced zero bytes (some hosts alias mysqldump to nothing these days).
            if (($ret !== 0 || !file_exists($dumpPath) || filesize($dumpPath) === 0) && $foundBin === 'mysqldump') {
                $mariaBins = ['/usr/bin/mariadb-dump', '/usr/local/bin/mariadb-dump', 'mariadb-dump'];
                foreach ($mariaBins as $mBin) {
                    $ok = ($mBin === 'mariadb-dump') ? true : @is_executable($mBin);
                    if (!$ok) continue;
                    $mariaCmd = "{$mBin} --user={$escUser} --password={$escPass} --host={$escHost} --port={$escPort}"
                              . " --single-transaction --quick --lock-tables=false --default-character-set=utf8mb4"
                              . " --column-statistics=0 --no-tablespaces"
                              . " --routines --triggers --events {$escDb}"
                              . " > {$escOut} 2>{$escErr}";
                    @exec($mariaCmd, $outArr2, $ret2);
                    if ($ret2 === 0 && file_exists($dumpPath) && filesize($dumpPath) > 0) {
                        $ret = 0;
                        break;
                    }
                }
            }

            // Post-process the dump file with a sanitizer even when source-side fix worked:
            // strips any leading stderr-leak lines if old/third-party source was involved,
            // MariaDB sandbox-mode comment lines that confuse older targets, stray BOMs, etc.
            if (file_exists($dumpPath) && filesize($dumpPath) > 0) {
                slate_sanitize_sql_dump_file($dumpPath);
            }

            // If dump succeeded, capture stderr warnings (non-fatal) into response metadata.
            $stderrText = '';
            if (file_exists($errLog)) {
                $stderrText = (string)@file_get_contents($errLog);
                @unlink($errLog);
            }

            if ($ret === 0 && file_exists($dumpPath) && filesize($dumpPath) > 0) {
                $dumpSuccess = true;
                if (trim($stderrText) !== '') {
                    // Non-fatal stderr messages go into the DB-persisted agent CONFIG so the
                    // master caller can surface warnings without breaking the dump.
                    $GLOBALS['SLATE_DUMP_STDERR'] = $stderrText;
                }
            } else {
                $dumpError = "mysqldump/mariadb-dump exit={$ret}: "
                    . implode(' ', array_slice($outArr, 0, 3))
                    . ($stderrText ? ' || STDERR: ' . substr(trim(preg_replace('/\s+/', ' ', $stderrText)), 0, 500) : '');
            }
        } else {
            $dumpError = "mysqldump binary not found in PATH.";
        }
    } else {
        $dumpError = "exec() disabled by php.ini disable_functions.";
    }

    // Strategy B: PHP-level dump via PDO (slower but works anywhere)
    if (!$dumpSuccess && extension_loaded('pdo_mysql')) {
        try {
            $dsn = "mysql:host={$dbHost};port={$dbPort};dbname={$dbName};charset=utf8mb4";
            $pdo = new PDO($dsn, $dbUser, $dbPass, [
                PDO::ATTR_TIMEOUT => 10,
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            ]);
            $fp = fopen($dumpPath, 'wb');
            if (!$fp) throw new Exception("Cannot open dump file for writing.");

            fwrite($fp, "-- SLATE DevOps OS Auto-Dump\n");
            fwrite($fp, "-- Source: {$dbName} @ {$dbHost}\n");
            fwrite($fp, "-- Generated: " . date('c') . "\n");
            fwrite($fp, "SET NAMES utf8mb4;\n");
            fwrite($fp, "SET FOREIGN_KEY_CHECKS=0;\n\n");

            $tables = $pdo->query("SHOW TABLES")->fetchAll(PDO::FETCH_COLUMN);
            foreach ($tables as $table) {
                $createRow = $pdo->query("SHOW CREATE TABLE `{$table}`")->fetch(PDO::FETCH_ASSOC);
                fwrite($fp, "-- Table: {$table}\n");
                fwrite($fp, "DROP TABLE IF EXISTS `{$table}`;\n");
                fwrite($fp, ($createRow['Create Table'] ?? $createRow['Create View'] ?? '') . ";\n\n");

                $rows = $pdo->query("SELECT * FROM `{$table}`");
                while ($row = $rows->fetch(PDO::FETCH_ASSOC)) {
                    $cols = array_map(function ($c) { return "`" . $c . "`"; }, array_keys($row));
                    $vals = array_values($row);
                    $escVals = [];
                    foreach ($vals as $v) {
                        if ($v === null) $escVals[] = 'NULL';
                        elseif (is_numeric($v)) $escVals[] = $v;
                        else $escVals[] = $pdo->quote((string)$v);
                    }
                    fwrite($fp, "INSERT INTO `{$table}` (" . implode(', ', $cols) . ") VALUES (" . implode(', ', $escVals) . ");\n");
                }
                fwrite($fp, "\n");
            }
            fwrite($fp, "SET FOREIGN_KEY_CHECKS=1;\n");
            fclose($fp);
            $dumpSuccess = file_exists($dumpPath) && filesize($dumpPath) > 0;
            if (!$dumpSuccess) $dumpError = "PDO dump produced empty file.";
        } catch (Exception $e) {
            $dumpError = ($dumpError ? $dumpError . ' | ' : '') . 'PDO dump: ' . $e->getMessage();
        }
    }

    if (!$dumpSuccess) {
        @unlink($dumpPath);
        respond(500, ['error' => 'Database dump failed: ' . ($dumpError ?: 'Unknown reason. Check DB credentials and user privileges (SELECT, SHOW VIEW, TRIGGER, LOCK TABLES).')]);
    }

    $size = filesize($dumpPath);
    $downloadToken = 'slate_dl_' . $tokenSuffix;
    if (!is_array($config)) $config = [];
    $config['pending_downloads'][$downloadToken] = [
        'path'    => $dumpPath,
        'size'    => $size,
        'expires' => time() + 900,
        'type'    => 'sql',
        'db_name' => $dbName,
    ];
    saveConfig($config);

    $tableCount = 0;
    try {
        $dsn2 = "mysql:host={$dbHost};port={$dbPort};dbname={$dbName};charset=utf8mb4";
        $pdo2 = new PDO($dsn2, $dbUser, $dbPass, [PDO::ATTR_TIMEOUT => 5, PDO::ATTR_ERRMODE => PDO::ERRMODE_SILENT]);
        $tableCount = (int)$pdo2->query("SHOW TABLES")->rowCount();
    } catch (Throwable $e) {}

    respond(200, [
        'status'       => 'DUMPED',
        'message'      => "Database dump completed: {$dbName} (" . round($size / 1048576, 2) . " MB).",
        'db_name'      => $dbName,
        'tables'       => $tableCount,
        'size_bytes'   => $size,
        'size_mb'      => round($size / 1048576, 2),
        'download_token' => $downloadToken,
        'download_url'   => (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on' ? 'https' : 'http')
            . '://' . ($_SERVER['HTTP_HOST'] ?? $_SERVER['SERVER_NAME'] ?? 'localhost')
            . ($_SERVER['REQUEST_URI'] ? parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) : '/auth.php')
            . '?action=download_package&token=' . urlencode($downloadToken),
    ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// 10. SQL IMPORT — Apply a .sql dump into MySQL on the target side
// ═════════════════════════════════════════════════════════════════════════════
if ($action === 'sql_import') {
    if (!authenticateAgent($payload)) {
        respond(401, ['error' => 'Unauthorized. Invalid X-Slate-Token.']);
    }

    $sqlContent = null;
    $tmpPath    = null;

    if (isset($_FILES['sql_file']) && $_FILES['sql_file']['error'] === UPLOAD_ERR_OK) {
        $tmpPath = $_FILES['sql_file']['tmp_name'];
    } elseif (!empty($payload['sql_base64'])) {
        $tmpPath = __DIR__ . '/.slate_import_' . time() . '.sql';
        $decoded = base64_decode((string)$payload['sql_base64'], true);
        if ($decoded === false) {
            respond(400, ['error' => 'sql_base64 is not valid base64.']);
        }
        @file_put_contents($tmpPath, $decoded);
    } elseif (!empty($payload['sql_text'])) {
        $tmpPath = __DIR__ . '/.slate_import_' . time() . '.sql';
        @file_put_contents($tmpPath, (string)$payload['sql_text']);
    }

    if (!$tmpPath || !file_exists($tmpPath) || filesize($tmpPath) === 0) {
        respond(400, ['error' => 'No SQL payload received. Provide sql_file (multipart), sql_base64, or sql_text.']);
    }

    $sanitizedBytes = slate_sanitize_sql_dump_file($tmpPath);
    if ($sanitizedBytes < 0 || !file_exists($tmpPath) || filesize($tmpPath) === 0) {
        @unlink($tmpPath);
        respond(400, ['error' => 'SQL payload could not be sanitized into a valid import file. Re-run source dump and retry.']);
    }

    $config = loadConfig();
    $dbHost = trim($payload['db_host'] ?? 'localhost');
    $dbPort = (int)($payload['db_port'] ?? 3306);
    $dbName = trim($payload['db_name'] ?? '');
    $dbUser = trim($payload['db_user'] ?? ($config['cpanel_user'] ?? ''));
    $dbPass = $payload['db_password'] ?? '';

    if ($dbName === '' || $dbUser === '') {
        $discovered = discoverDbCredentials(__DIR__);
        if ($dbName === '' && !empty($discovered['db_name'])) $dbName = $discovered['db_name'];
        if ($dbUser === '' && !empty($discovered['db_user'])) $dbUser = $discovered['db_user'];
        if ($dbPass === '' && !empty($discovered['db_pass'])) $dbPass = $discovered['db_pass'];
        if ($dbName === '' || $dbUser === '') {
            respond(400, ['error' => 'Target db_name and db_user are required for sql_import.']);
        }
    }

    $importedCount = 0;
    $importError   = '';

    // Strategy A: mysql CLI binary
    $disabled = array_map('trim', explode(',', (string)ini_get('disable_functions')));
    if (function_exists('exec') && !in_array('exec', $disabled)) {
        $mysqlBins = ['/usr/bin/mysql', '/usr/local/bin/mysql', 'mysql'];
        $foundBin = null;
        foreach ($mysqlBins as $bin) {
            if ($bin === 'mysql' || is_executable($bin)) { $foundBin = $bin; break; }
        }
        if ($foundBin) {
            $escUser = escapeshellarg($dbUser);
            $escPass = escapeshellarg($dbPass);
            $escHost = escapeshellarg($dbHost);
            $escDb   = escapeshellarg($dbName);
            $escIn   = escapeshellarg($tmpPath);
            $cmd = "{$foundBin} --user={$escUser} --password={$escPass} --host={$escHost} --port={$dbPort}"
                 . " --default-character-set=utf8mb4 {$escDb} < {$escIn} 2>&1";
            @exec($cmd, $outArr, $ret);
            if ($ret === 0) {
                $importedCount = 1;
            } else {
                $importError = "mysql exit={$ret}: " . implode(' ', array_slice($outArr, 0, 4));
            }
        }
    }

    // Strategy B: PDO multi-query line-by-line
    if (!$importedCount && extension_loaded('pdo_mysql')) {
        try {
            $dsn = "mysql:host={$dbHost};port={$dbPort};dbname={$dbName};charset=utf8mb4";
            $pdo = new PDO($dsn, $dbUser, $dbPass, [
                PDO::ATTR_TIMEOUT         => 60,
                PDO::ATTR_ERRMODE         => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_EMULATE_PREPARES => true,
            ]);
            $pdo->exec("SET FOREIGN_KEY_CHECKS=0");
            $pdo->exec("SET NAMES utf8mb4");

            $raw = file_get_contents($tmpPath);
            if ($raw === false) throw new Exception("Cannot read SQL tmp file.");

            $queries = splitSqlStatements($raw);
            $done = 0;
            foreach ($queries as $q) {
                $trimmed = trim($q);
                if ($trimmed === '' || strpos($trimmed, '--') === 0 || strpos($trimmed, '#') === 0) continue;
                try {
                    $pdo->exec($trimmed);
                    $done++;
                } catch (PDOException $e) {
                    $msg = $e->getMessage();
                    if (stripos($msg, 'Duplicate entry') !== false || stripos($msg, 'already exists') !== false) {
                        continue;
                    }
                    $importError = "Query failed: {$msg} || SQL snippet: " . substr($trimmed, 0, 220);
                    break;
                }
            }
            $pdo->exec("SET FOREIGN_KEY_CHECKS=1");
            if ($done > 0 || $importError === '') {
                $importedCount = $done;
            }
        } catch (Exception $e) {
            $importError = ($importError ? $importError . ' | ' : '') . 'PDO: ' . $e->getMessage();
        }
    }

    @unlink($tmpPath);
    if (function_exists('opcache_reset')) @opcache_reset();

    $tableCount = 0;
    try {
        $dsn2 = "mysql:host={$dbHost};port={$dbPort};dbname={$dbName};charset=utf8mb4";
        $pdo2 = new PDO($dsn2, $dbUser, $dbPass, [PDO::ATTR_TIMEOUT => 5, PDO::ATTR_ERRMODE => PDO::ERRMODE_SILENT]);
        $tableCount = (int)$pdo2->query("SHOW TABLES")->rowCount();
    } catch (Throwable $e) {}

    if (!$importedCount && $importError) {
        respond(500, [
            'error' => 'SQL import failed: ' . $importError,
            'target_db' => $dbName,
        ]);
    }

    respond(200, [
        'status'        => 'IMPORTED',
        'message'       => "SQL dump imported into {$dbName}. Queries executed: {$importedCount}. Tables now present: {$tableCount}.",
        'target_db'     => $dbName,
        'queries_run'   => $importedCount,
        'tables_count'  => $tableCount,
        'imported_at'   => date('c'),
    ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// 11. WRITE CONFIG — Update wp-config.php or .env with new DB credentials + URL
// ═════════════════════════════════════════════════════════════════════════════
if ($action === 'write_config') {
    if (!authenticateAgent($payload)) {
        respond(401, ['error' => 'Unauthorized. Invalid X-Slate-Token.']);
    }

    $warnings = [];
    $updated = [];

    $wpPath = __DIR__ . '/wp-config.php';
    if (file_exists($wpPath) && is_writable($wpPath)) {
        $content = @file_get_contents($wpPath);
        if ($content !== false) {
            $replacements = [
                'DB_NAME' => $payload['db_name'] ?? null,
                'DB_USER' => $payload['db_user'] ?? null,
                'DB_PASSWORD' => $payload['db_password'] ?? null,
                'DB_HOST' => $payload['db_host'] ?? null,
            ];
            foreach ($replacements as $const => $value) {
                if ($value === null) continue;
                $escValue = addslashes((string)$value);
                $pattern = "/define\s*\(\s*['\"]" . preg_quote($const, '/') . "['\"]\s*,\s*['\"][^'\"]*['\"]\s*\)\s*;/";
                $replacement = "define('{$const}', '{$escValue}');";
                $newContent = preg_replace($pattern, $replacement, $content, 1, $count);
                if ($count > 0) {
                    $content = $newContent;
                    $updated[] = "wp-config.php:{$const}";
                }
            }
            if (!empty($payload['wp_homeurl']) || !empty($payload['wp_siteurl']) || !empty($payload['site_url'])) {
                $home = $payload['wp_homeurl'] ?? $payload['site_url'] ?? null;
                $site = $payload['wp_siteurl'] ?? $home;
                if ($home) {
                    $p1 = "/define\s*\(\s*['\"]WP_HOME['\"]\s*,\s*['\"][^'\"]*['\"]\s*\)\s*;/";
                    $c1 = preg_match($p1, $content);
                    if ($c1) {
                        $content = preg_replace($p1, "define('WP_HOME', '" . addslashes($home) . "');", $content, 1, $cnt);
                        if ($cnt) $updated[] = 'wp-config.php:WP_HOME';
                    } else {
                        $content = "\ndefine('WP_HOME', '" . addslashes($home) . "');\n" . $content;
                        $updated[] = 'wp-config.php:WP_HOME(injected)';
                    }
                }
                if ($site) {
                    $p2 = "/define\s*\(\s*['\"]WP_SITEURL['\"]\s*,\s*['\"][^'\"]*['\"]\s*\)\s*;/";
                    $c2 = preg_match($p2, $content);
                    if ($c2) {
                        $content = preg_replace($p2, "define('WP_SITEURL', '" . addslashes($site) . "');", $content, 1, $cnt);
                        if ($cnt) $updated[] = 'wp-config.php:WP_SITEURL';
                    } else {
                        $content = "\ndefine('WP_SITEURL', '" . addslashes($site) . "');\n" . $content;
                        $updated[] = 'wp-config.php:WP_SITEURL(injected)';
                    }
                }
            }
            if (@file_put_contents($wpPath, $content) === false) {
                $warnings[] = "wp-config.php exists but could not be written (permission denied).";
            }
        }
    } elseif (file_exists($wpPath) && !is_writable($wpPath)) {
        $warnings[] = "wp-config.php exists but is not writable (permissions=0" . decoct(fileperms($wpPath) & 0777) . ").";
    }

    $envPath = __DIR__ . '/.env';
    /**
     * CREATE the .env when it does not exist.
     *
     * This used to be `if (file_exists($envPath) && is_writable($envPath))`, so on
     * a FRESH client install — where the app release ships no .env — the whole
     * block was skipped and write_config still reported success. The app then fell
     * back to the default baked into config.php (`env('APP_URL', '...')`), which
     * is why a brand-new site kept pointing at the OLD demo URL and admin/login.php
     * returned 500 for lack of DB credentials. Master believed CONFIG had passed.
     *
     * Now: create it if missing, and refuse to claim success when it cannot be
     * written, so a failure is visible instead of silently deferred.
     */
    $envExists = file_exists($envPath);
    if (!$envExists) {
        if (is_writable(__DIR__)) {
            if (@file_put_contents($envPath, "# Slate configuration — written by SLATE Master OS\n") === false) {
                $warnings[] = '.env could not be created (permission denied on ' . __DIR__ . ').';
            } else {
                @chmod($envPath, 0640);
                $envExists = true;
                $updated[] = '.env(created)';
            }
        } else {
            $warnings[] = '.env is missing and the folder is not writable, so it could not be created.';
        }
    } elseif (!is_writable($envPath)) {
        $warnings[] = '.env exists but is not writable (permissions=0' . decoct(fileperms($envPath) & 0777) . ').';
    }

    if ($envExists && is_writable($envPath)) {
        $env = @file_get_contents($envPath);
        if ($env !== false) {
            // SLATE CANONICAL KEYS FIRST (config.php reads DB_HOST/DB_NAME/DB_USER/DB_PASS + APP_URL).
            // Laravel-style aliases (DB_DATABASE/DB_USERNAME) are kept in sync for compat.
            $map = [
                'APP_URL'     => $payload['site_url'] ?? null,
                'DB_HOST'     => $payload['db_host'] ?? null,
                'DB_NAME'     => $payload['db_name'] ?? null,
                'DB_USER'     => $payload['db_user'] ?? null,
                'DB_PASS'     => $payload['db_password'] ?? null,
                'DB_DATABASE' => $payload['db_name'] ?? null,
                'DB_USERNAME' => $payload['db_user'] ?? null,
                'DB_PASSWORD' => $payload['db_password'] ?? null,
                'SITE_URL'    => $payload['site_url'] ?? null,
                'BASE_URL'    => $payload['site_url'] ?? null,
                'PUBLIC_URL'  => $payload['site_url'] ?? null,
                'APP_BASE_PATH' => $payload['base_path'] ?? null,
            ];
            // Arbitrary KEY=VALUE pairs pushed by Master (LICENSE_KEY, renewal metadata, ...)
            if (!empty($payload['extra_env']) && is_array($payload['extra_env'])) {
                foreach ($payload['extra_env'] as $ek => $ev) {
                    if (!is_string($ek) || !preg_match('/^[A-Z0-9_]+$/', $ek)) continue;
                    if ($ev === null || $ev === '') continue;
                    $map[$ek] = $ev;
                }
            }
            foreach ($map as $k => $v) {
                if ($v === null || $v === '') continue;
                // preg_replace replacement string treats $ and \ specially;
                // build the new line without preg_replace to avoid corrupting
                // passwords like s%$#8JNZuQVF#otpp7.
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
    }

    // ── config.php: the app's hardcoded fallback URL ──────────────────────
    // config.php ships with a DEMO fallback, e.g.
    //   define('SLATE_URL', rtrim(env('APP_URL', 'https://old-demo.com/slate'), '/'));
    // When .env failed to reach the server that fallback became the live URL,
    // so a client's site silently pointed at somebody else's demo domain. Rewrite
    // the fallback to this site's real URL as a belt-and-braces guarantee, even
    // though .env is the primary source of truth.
    $configPath = __DIR__ . '/config.php';
    if (file_exists($configPath) && is_writable($configPath) && !empty($payload['site_url'])) {
        $cfg = @file_get_contents($configPath);
        if ($cfg !== false) {
            $newUrl = rtrim((string)$payload['site_url'], '/');
            // Replace the SECOND argument of env('APP_URL', '...') only.
            $cfgNew = preg_replace_callback(
                "/env\s*\(\s*(['\"])APP_URL\1\s*,\s*(['\"])[^'\"]*\2\s*\)/",
                function ($m) use ($newUrl) {
                    return "env('APP_URL', '" . addslashes($newUrl) . "')";
                },
                $cfg, -1, $cfgCnt
            );
            if (!empty($cfgCnt) && $cfgNew !== null) {
                if (@file_put_contents($configPath, $cfgNew) !== false) {
                    $updated[] = 'config.php:SLATE_URL(' . $newUrl . ')';
                    $cfg = $cfgNew;
                } else {
                    $warnings[] = 'config.php exists but could not be written (permission denied).';
                }
            }
            // Also rebase any remaining hardcoded demo host in this file.
            if (preg_match_all("/https?:\/\/[a-z0-9.-]+(?:\/[^'\"\s,)]*)?/i", $cfg, $m2)) {
                foreach (array_unique($m2[0]) as $found) {
                    if (stripos($found, 'localhost') !== false) continue;
                    // Only rewrite hosts that are clearly not this site.
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
    } elseif (file_exists($configPath) && !is_writable($configPath)) {
        $warnings[] = 'config.php exists but is not writable; it may still contain a demo fallback URL.';
    }

    // Package restriction map: lets the Slate app switch to read-only mode after
    // the license expires (per-package admin paths configured in Master).
    if (isset($payload['restrictions']) && is_array($payload['restrictions'])) {
        $restPath = __DIR__ . '/.slate_restrictions.json';
        $restJson = json_encode(array_values($payload['restrictions']), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        if (@file_put_contents($restPath, $restJson) !== false) {
            $updated[] = '.slate_restrictions.json(' . count($payload['restrictions']) . ' rules)';
        } else {
            $warnings[] = '.slate_restrictions.json could not be written (permission denied).';
        }
    }

    // ── Slate .htaccess auto-rebase (subfolder-aware) ─────────────────────
    // The Slate PHP app hardcodes RewriteBase + ErrorDocument paths (e.g. /solaya/).
    // After files are copied to a different target folder those must follow the
    // new public path or every rewritten route 404s while real files still load.
    $htPath = __DIR__ . '/.htaccess';
    // base_path "/" (or empty) means domain root: ErrorDocument must drop the
    // subfolder, RewriteBase must become "/". Only skip when key is absent.
    $hasBase = array_key_exists('base_path', $payload);
    if ($hasBase && file_exists($htPath) && is_writable($htPath)) {
        $ht = @file_get_contents($htPath);
        if ($ht !== false) {
            $base = '/' . trim((string)$payload['base_path'], '/');
            $base = ($base === '/' || $base === '') ? '/' : $base . '/';
            $htNew = preg_replace('/^\s*RewriteBase\s+\S+\s*$/m', '    RewriteBase ' . $base, $ht, 1, $rbCnt);
            if (!empty($rbCnt)) { $ht = $htNew; $updated[] = '.htaccess:RewriteBase(' . $base . ')'; }
            $htNew2 = preg_replace_callback(
                '/^(\s*ErrorDocument\s+\d+\s+)(\/\S*)(\s.*)?$/m',
                function ($m) use ($base) {
                    $file = basename($m[2]);
                    return $m[1] . $base . $file;
                },
                $ht, -1, $edCnt
            );
            if (!empty($edCnt)) { $ht = $htNew2; $updated[] = '.htaccess:ErrorDocument(' . $base . ')'; }
            @file_put_contents($htPath, $ht);
        }
    } elseif ($hasBase && file_exists($htPath) && !is_writable($htPath)) {
        $warnings[] = ".htaccess exists but is not writable; RewriteBase still points at the source folder.";
    }

    // Never delete the install gate marker: files were copied from an installed
    // source, but .installed itself is excluded from the zip so the target would
    // otherwise boot into install.php on first hit. Touch it when absent.
    $markerPath = __DIR__ . '/.installed';
    if (!file_exists($markerPath) && is_writable(__DIR__)) {
        @file_put_contents($markerPath, 'Installed: ' . date('Y-m-d H:i:s') . " | Slate migrated via SLATE Master OS\n");
        @chmod($markerPath, 0640);
        $updated[] = '.installed(restored)';
    }

    // Fix file permissions (0644 files, 0755 dirs) — best effort
    if (!empty($payload['fix_permissions'])) {
        $dirsFixed  = 0;
        $filesFixed = 0;
        $iter = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator(__DIR__, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::SELF_FIRST
        );
        foreach ($iter as $f) {
            $name = $f->getFilename();
            if ($name === 'auth.php' || strpos($name, '.slate_') === 0) continue;
            if ($f->isDir()) { @chmod($f->getPathname(), 0755); $dirsFixed++; }
            elseif ($f->isFile()) { @chmod($f->getPathname(), 0644); $filesFixed++; }
        }
        $updated[] = "permissions:dirs={$dirsFixed},files={$filesFixed}";
    }

    // Never report success when the configuration did not actually land.
    //
    // This used to return 200 with "No writable wp-config.php or .env detected.
    // Skipped config update." — Master reads that as success, moves on to INSTALL,
    // and the client's site boots with no .env and a demo fallback URL. A skipped
    // CONFIG is a FAILED config; saying so lets the install stop with a real
    // reason instead of producing a broken site that looks finished.
    $envWrote = false;
    foreach ($updated as $u) {
        if (strpos($u, '.env:') === 0 || $u === '.env(created)') { $envWrote = true; break; }
    }
    $dbKeys = !empty($payload['db_name']) && !empty($payload['db_user']);

    if ($dbKeys && !$envWrote) {
        respond(500, [
            'status'  => 'CONFIG_FAILED',
            'error'   => 'The database settings could not be written to the server: .env was not created or updated. ' . (empty($warnings) ? 'The folder may be read-only.' : implode(' ', $warnings)),
            'updated' => $updated,
            'warnings'=> $warnings,
        ]);
    }

    respond(200, [
        'status'   => 'CONFIG_UPDATED',
        'message'  => empty($updated) ? 'No writable config files detected; nothing was changed.' : 'Updated ' . implode(', ', $updated) . '.',
        'updated'  => $updated,
        'warnings' => $warnings,
    ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// 12. LICENSE ACTIONS (v3.1.0) — status / set key / enforce
// Never logs or echoes the raw key. Raw key accepted only to install.
// ═════════════════════════════════════════════════════════════════════════════
if ($action === 'license_status') {
    if (!authenticateAgent($payload)) {
        respond(401, ['error' => 'Unauthorized. Invalid X-Slate-Token.']);
    }
    $license = slate_license_read_local();
    respond(200, [
        'status' => 'LICENSE_STATUS',
        'license' => [
            'status' => $license['status'],
            'expires_at' => $license['expires_at'],
            'domain' => $license['domain'],
            'plan_slug' => $license['plan_slug'],
            'last_validated_at' => $license['last_validated_at'],
        ],
    ]);
}

if ($action === 'license_set_key') {
    if (!authenticateAgent($payload)) {
        respond(401, ['error' => 'Unauthorized. Invalid X-Slate-Token.']);
    }
    $key = trim((string)($payload['key'] ?? ''));
    if (!preg_match('/^SLT-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/', $key)) {
        respond(400, ['error' => 'Invalid key format. Expected SLT-XXXX-XXXX-XXXX-XXXX.']);
    }
    // Rate-limit key attempts: max 10/min per IP via best-effort marker files.
    $rlDir = sys_get_temp_dir() . '/slate_lic_rl';
    @mkdir($rlDir, 0700, true);
    $rlFile = $rlDir . '/' . preg_replace('/[^a-z0-9]/i', '', (string)($_SERVER['REMOTE_ADDR'] ?? 'x'));
    $hits = [];
    if (file_exists($rlFile)) { $hits = array_filter(array_map('intval', explode(',', (string)@file_get_contents($rlFile)))); }
    $now = time();
    $hits = array_values(array_filter($hits, function ($t) use ($now) { return ($now - $t) < 60; }));
    if (count($hits) >= 10) { respond(429, ['error' => 'Too many key attempts. Try again in a minute.']); }
    $hits[] = $now;
    @file_put_contents($rlFile, implode(',', $hits));

    // Persist key hash reference + install LICENSE_KEY into .env (mode 0600 best-effort).
    $envPath = __DIR__ . '/.env';
    $installed = false;
    if (file_exists($envPath) && is_writable($envPath)) {
        $env = (string)@file_get_contents($envPath);
        $lines = explode("\n", $env);
        $newLine = 'LICENSE_KEY="' . addslashes($key) . '"';
        $found = false;
        foreach ($lines as $i => $ln) {
            if (preg_match('/^LICENSE_KEY=.*$/', rtrim($ln, "\r"))) { $lines[$i] = $newLine; $found = true; break; }
        }
        if (!$found) { $env = rtrim($env, "\r\n") . "\n" . $newLine; }
        else { $env = implode("\n", $lines); }
        @file_put_contents($envPath, $env);
        $installed = true;
    }
    $config = loadConfig();
    $config['license_key_hash'] = hash('sha256', $key);
    $config['license_installed_at'] = date('c');
    saveConfig($config);
    respond(200, [
        'status' => 'LICENSE_INSTALLED',
        'message' => $installed ? 'License key installed into .env.' : 'Key recorded. No writable .env found.',
        'key_last4' => substr($key, -4),
    ]);
}

if ($action === 'license_enforce') {
    if (!authenticateAgent($payload)) {
        respond(401, ['error' => 'Unauthorized. Invalid X-Slate-Token.']);
    }
    $op = strtolower(trim((string)($payload['op'] ?? $payload['enforce'] ?? '')));
    if (!in_array($op, ['suspend', 'revoke', 'activate', 'extend'], true)) {
        respond(400, ['error' => 'op must be suspend|revoke|activate|extend.']);
    }
    $config = loadConfig();
    $config['license_enforced'] = $op;
    $config['license_enforced_at'] = date('c');
    $config['license_enforced_reason'] = substr((string)($payload['reason'] ?? ''), 0, 255);
    if ($op === 'extend' && !empty($payload['expires_at'])) {
        $config['license_expires_at'] = (string)$payload['expires_at'];
    }
    saveConfig($config);
    // Best-effort: also flip local Slate DB row when the full app is present.
    $dbNote = slate_license_apply_db($op, isset($payload['expires_at']) ? (string)$payload['expires_at'] : null);
    respond(200, ['status' => 'LICENSE_ENFORCED', 'op' => $op, 'db' => $dbNote]);
}

// ═════════════════════════════════════════════════════════════════════════════
// 13. SITE OVERVIEW (v3.2.0) — core version, active plugins, access mode
// Read-only. Never mutates anything, never returns a secret. Used by the Master
// client-management console ("what is actually running on this site?").
// ═════════════════════════════════════════════════════════════════════════════
if ($action === 'site_overview') {
    if (!authenticateAgent($payload)) {
        respond(401, ['error' => 'Unauthorized. Invalid X-Slate-Token.']);
    }

    /* ── Slate core version (config.php constant → .slate_version file) ── */
    $coreVersion = null;
    $cfgPath = __DIR__ . '/config.php';
    if (is_readable($cfgPath) && ($cfgRaw = @file_get_contents($cfgPath)) !== false) {
        if (preg_match("/define\s*\(\s*'SLATE_VERSION'\s*,\s*'([^']+)'/", $cfgRaw, $m)) {
            $coreVersion = $m[1];
        }
    }
    if ($coreVersion === null && is_readable(__DIR__ . '/.slate_version')) {
        $v = trim((string)@file_get_contents(__DIR__ . '/.slate_version'));
        $coreVersion = $v !== '' ? $v : null;
    }

    /* ── .env (DB creds + Master-pushed flags such as SLATE_ACCESS_MODE) ─ */
    $env = [];
    $envPath = __DIR__ . '/.env';
    if (is_readable($envPath)) {
        foreach ((array)@file($envPath, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            $t = trim($line);
            if ($t === '' || $t[0] === '#' || strpos($t, '=') === false) continue;
            list($k, $v) = explode('=', $t, 2);
            $env[trim($k)] = trim($v, " \t\"'");
        }
    }

    $accessMode = strtolower(trim((string)($env['SLATE_ACCESS_MODE'] ?? '')));
    if (!in_array($accessMode, ['full', 'readonly'], true)) {
        // No Master-pushed mode yet: infer it from the restriction file so the
        // console still reports the truth on an older install.
        $accessMode = 'full';
        if (is_readable(__DIR__ . '/.slate_restrictions.json')) {
            $probe = json_decode((string)@file_get_contents(__DIR__ . '/.slate_restrictions.json'), true);
            if (is_array($probe) && count($probe) === 1
                && strtolower((string)($probe[0]['match'] ?? '')) === '*'
                && strtolower((string)($probe[0]['mode'] ?? '')) === 'readonly') {
                $accessMode = 'readonly';
            }
        }
    }
    /* ── restriction rules (Master-pushed file first, DB table fallback) ─ */
    $rules = [];
    if (is_readable(__DIR__ . '/.slate_restrictions.json')) {
        $decoded = json_decode((string)@file_get_contents(__DIR__ . '/.slate_restrictions.json'), true);
        if (is_array($decoded)) {
            foreach ($decoded as $r) {
                if (is_array($r) && !empty($r['match'])) {
                    $rules[] = ['match' => (string)$r['match'], 'mode' => (string)($r['mode'] ?? 'block')];
                }
            }
        }
    }

    /* ── plugins: DB registry merged with the manifests found on disk ──── */
    $plugins = [];
    $dbNote = null;
    if (!empty($env['DB_NAME']) && !empty($env['DB_USER']) && extension_loaded('pdo_mysql')) {
        try {
            $dbHost = !empty($env['DB_HOST']) ? $env['DB_HOST'] : 'localhost';
            $pdo = new PDO(
                'mysql:host=' . $dbHost . ';dbname=' . $env['DB_NAME'] . ';charset=utf8mb4',
                $env['DB_USER'],
                isset($env['DB_PASS']) ? $env['DB_PASS'] : '',
                [PDO::ATTR_TIMEOUT => 4, PDO::ATTR_ERRMODE => PDO::ERRMODE_SILENT]
            );
            $rows = $pdo->query('SELECT slug, name, version, status FROM plugins ORDER BY id ASC');
            if ($rows) {
                foreach ($rows->fetchAll(PDO::FETCH_ASSOC) as $r) {
                    $slug = (string)$r['slug'];
                    $plugins[$slug] = [
                        'slug' => $slug, 'name' => (string)$r['name'],
                        'version' => isset($r['version']) ? (string)$r['version'] : '',
                        'status' => isset($r['status']) ? (string)$r['status'] : 'installed',
                        'active' => (isset($r['status']) ? (string)$r['status'] : '') === 'active',
                        'source' => 'db',
                    ];
                }
            }
            if (empty($rules)) {
                $rr = $pdo->query('SELECT `match`, `mode` FROM package_restrictions ORDER BY sort_order ASC, id ASC');
                if ($rr) {
                    foreach ($rr->fetchAll(PDO::FETCH_ASSOC) as $r) {
                        $rules[] = ['match' => (string)$r['match'], 'mode' => (string)$r['mode']];
                    }
                }
            }
        } catch (Throwable $e) {
            $dbNote = 'db skipped: ' . substr($e->getMessage(), 0, 120);
        }
    }

    /* Anything on disk but unknown to the registry still needs activation. */
    foreach ((array)@glob(__DIR__ . '/plugins/*/plugin.json') as $manifestPath) {
        $slug = basename(dirname($manifestPath));
        if ($slug === '' || isset($plugins[$slug])) continue;
        $man = json_decode((string)@file_get_contents($manifestPath), true);
        $plugins[$slug] = [
            'slug' => $slug,
            'name' => is_array($man) ? (string)($man['name'] ?? $slug) : $slug,
            'version' => is_array($man) ? (string)($man['version'] ?? '') : '',
            'status' => 'on_disk',
            'active' => false,
            'source' => 'disk',
        ];
    }

    $pluginList = array_values($plugins);
    $activeCount = 0;
    foreach ($pluginList as $p) {
        if (!empty($p['active'])) $activeCount++;
    }

    respond(200, [
        'status'              => 'OK',
        'agent_version'       => SLATE_AGENT_VERSION,
        'supported_actions'   => $GLOBALS['SLATE_SUPPORTED_ACTIONS'] ?? $SLATE_SUPPORTED_ACTIONS,
        'core_version'        => $coreVersion,
        'access_mode'         => $accessMode,
        'restriction_rules'   => $rules,
        'plugins'             => $pluginList,
        'plugin_count'        => count($pluginList),
        'active_plugin_count' => $activeCount,
        'app_installed'       => file_exists(__DIR__ . '/.installed'),
        'license'             => slate_license_read_local(),
        'php_version'         => PHP_VERSION,
        'server_software'     => $_SERVER['SERVER_SOFTWARE'] ?? 'Unknown',
        'db_note'             => $dbNote,
        'message'             => 'Core ' . ($coreVersion ?: 'unknown') . ' | ' . $activeCount . ' active plugin(s) of '
                                 . count($pluginList) . ' | access mode: ' . $accessMode . '.',
    ]);
}



// ═════════════════════════════════════════════════════════════════════════════
// Helpers (shared)
// ═════════════════════════════════════════════════════════════════════════════
function slate_license_read_local() {
    $out = ['status' => 'none', 'expires_at' => null, 'domain' => null, 'plan_slug' => null, 'last_validated_at' => null];
    $config = loadConfig();
    if (!empty($config['license_enforced'])) {
        $map = ['suspend' => 'suspended', 'revoke' => 'revoked', 'activate' => 'active'];
        $op = (string)$config['license_enforced'];
        if (isset($map[$op])) $out['status'] = $map[$op];
        if ($op === 'extend' && !empty($config['license_expires_at'])) $out['expires_at'] = $config['license_expires_at'];
    }
    // Best-effort: read full-app DB when present (never fails diagnostics).
    try {
        $envPath = __DIR__ . '/.env';
        $dbHost = 'localhost'; $dbName = ''; $dbUser = ''; $dbPass = '';
        if (file_exists($envPath)) {
            foreach ((array)@file($envPath, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
                $t = trim($line);
                if ($t === '' || $t[0] === '#' || strpos($t, '=') === false) continue;
                list($k, $v) = explode('=', $t, 2);
                $k = trim($k); $v = trim($v, " \t\"'");
                if ($k === 'DB_HOST') $dbHost = $v;
                elseif ($k === 'DB_NAME' || $k === 'DB_DATABASE') { if ($dbName === '') $dbName = $v; }
                elseif ($k === 'DB_USER' || $k === 'DB_USERNAME') { if ($dbUser === '') $dbUser = $v; }
                elseif ($k === 'DB_PASS' || $k === 'DB_PASSWORD') { if ($dbPass === '') $dbPass = $v; }
            }
        }
        if ($dbName !== '' && $dbUser !== '' && extension_loaded('pdo_mysql')) {
            $pdo = new PDO("mysql:host={$dbHost};dbname={$dbName};charset=utf8mb4", $dbUser, $dbPass, [PDO::ATTR_TIMEOUT => 4, PDO::ATTR_ERRMODE => PDO::ERRMODE_SILENT]);
            $row = $pdo->query("SELECT status, expires_at, last_validated_at, metadata FROM licenses ORDER BY id DESC LIMIT 1");
            if ($row && ($r = $row->fetch(PDO::FETCH_ASSOC))) {
                $out['status'] = (string)($r['status'] ?? $out['status']);
                $out['expires_at'] = $r['expires_at'] ?? $out['expires_at'];
                $out['last_validated_at'] = $r['last_validated_at'] ?? $out['last_validated_at'];
                $meta = json_decode((string)($r['metadata'] ?? ''), true);
                if (is_array($meta)) {
                    if (!empty($meta['domain'])) $out['domain'] = $meta['domain'];
                    if (!empty($meta['plan_slug'])) $out['plan_slug'] = $meta['plan_slug'];
                }
                if (($out['status'] === 'active' || $out['status'] === 'trial') && !empty($out['expires_at']) && strtotime((string)$out['expires_at']) <= time()) {
                    $out['status'] = 'expired';
                }
            }
        }
    } catch (Throwable $e) { /* best-effort only */ }
    return $out;
}

function slate_license_apply_db($op, $expiresAt = null) {
    try {
        $envPath = __DIR__ . '/.env';
        $dbHost = 'localhost'; $dbName = ''; $dbUser = ''; $dbPass = '';
        if (!file_exists($envPath)) return 'no .env (agent-only enforce)';
        foreach ((array)@file($envPath, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            $t = trim($line);
            if ($t === '' || $t[0] === '#' || strpos($t, '=') === false) continue;
            list($k, $v) = explode('=', $t, 2);
            $k = trim($k); $v = trim($v, " \t\"'");
            if ($k === 'DB_HOST') $dbHost = $v;
            elseif ($k === 'DB_NAME' || $k === 'DB_DATABASE') { if ($dbName === '') $dbName = $v; }
            elseif ($k === 'DB_USER' || $k === 'DB_USERNAME') { if ($dbUser === '') $dbUser = $v; }
            elseif ($k === 'DB_PASS' || $k === 'DB_PASSWORD') { if ($dbPass === '') $dbPass = $v; }
        }
        if ($dbName === '' || $dbUser === '' || !extension_loaded('pdo_mysql')) return 'no DB creds (agent-only enforce)';
        $pdo = new PDO("mysql:host={$dbHost};dbname={$dbName};charset=utf8mb4", $dbUser, $dbPass, [PDO::ATTR_TIMEOUT => 5, PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $status = $op === 'suspend' ? 'suspended' : ($op === 'revoke' ? 'revoked' : 'active');
        if ($op === 'extend' && $expiresAt) {
            $pdo->exec("UPDATE licenses SET status='active', expires_at=" . $pdo->quote($expiresAt) . " WHERE status IN ('expired','suspended','trial','active')");
            return 'db: extended';
        }
        $stmt = $pdo->prepare("UPDATE licenses SET status=? WHERE status NOT IN ('revoked','cancelled') OR ?='active'");
        $stmt->execute([$status, $status]);
        return 'db: status=' . $status;
    } catch (Throwable $e) {
        return 'db skipped: ' . substr($e->getMessage(), 0, 120);
    }
}

function slate_sanitize_sql_dump_file($path) {
    // Strips from the .sql file:
    //  1. Leading stderr-leak lines from mysqldump / mariadb-dump deprecation
    //     (e.g. "/usr/bin/mysqldump: Deprecated program name...").
    //  2. MariaDB 10.11 sandbox-mode comment lines (/*M!999999\- ... */) at
    //     line-start that cause MySQL/older-MariaDB targets to throw 1064.
    //  3. UTF-8/UTF-16 BOMs at the very start of the file.
    //  4. Shell/terminal escape / ANSI colour codes that some providers inject.
    // Returns number of bytes stripped, or -1 on IO error.  Always does an
    // in-place rewrite atomically.
    $raw = @file_get_contents($path);
    if ($raw === false || $raw === '') return -1;

    $before = strlen($raw);

    // (3) BOMs
    $bomUtf8  = "\xEF\xBB\xBF";
    $bomUtf16 = "\xFF\xFE";
    $bomUtf16Be = "\xFE\xFF";
    if (strpos($raw, $bomUtf8) === 0)    $raw = substr($raw, 3);
    elseif (strpos($raw, $bomUtf16) === 0)   $raw = substr($raw, 2);
    elseif (strpos($raw, $bomUtf16Be) === 0) $raw = substr($raw, 2);

    $lines = preg_split('/\r\n|\n|\r/', $raw);
    if (!is_array($lines)) return -1;

    $strippedHeader = false;
    $outLines = [];
    foreach ($lines as $ln) {
        $t = trim($ln);

        // (4) ANSI CSI sequences + shell colour codes (always strip)
        $ln = preg_replace('/\x1b\[[0-9;]*[A-Za-z]/', '', (string)$ln);
        $t = trim($ln);

        // (1) Strip header lines until we hit the first real SQL-ish line.
        //     Catches:
        //       "/usr/bin/mysqldump: Deprecated ..."
        //       "/usr/local/bin/mariadb-dump: Table 'x' has a comment..."
        //       "mysqldump: [Warning] Using a password..."
        //       Shell prompts like "# mysql  Ver 15.1..."
        //       Any line that starts with an absolute path (/) and ends with
        //       ":" (stderr-style program prefix).
        if (!$strippedHeader) {
            if ($t === ''
                || preg_match('#^/[^ ]+/(mysqldump|mariadb-dump|mysql|mariadb)(\.exe)?:#i', $t)
                || preg_match('#^(mysqldump|mariadb-dump|mysql|mariadb)(\.exe)?:#i', $t)
                || preg_match('#^/[^ ]+:\s#', $t)
                || preg_match('#^\[Warning\]|\[Note\]|\[ERROR\]#i', $t)
                || preg_match('#^--\s*M?![0-9]+\\\\?-\s*enable the sandbox mode\s*\*/#i', $t)) {
                continue;
            }
            // Real SQL always begins with '--' comment, '/*!' preamble, SET, CREATE, DROP, etc.
            $strippedHeader = true;
        }

        // (2) MariaDB 10.11 "enable the sandbox mode" executable comment lines
        //     at column 0 that older MySQL/Percona targets cannot parse.
        if (preg_match('#^/\*M?!999999\\\\?-\s*enable the sandbox mode\s*\*/\s*$#i', $t)) {
            continue;
        }

        $outLines[] = $ln;
    }

    $newRaw = implode("\n", $outLines);
    $written = @file_put_contents($path, $newRaw, LOCK_EX);
    if ($written === false) return -1;
    return $before - $written;
}

function testDbConnection($host, $user, $pass, $db = null) {
    $h = preg_replace('/:[0-9]+$/', '', (string)$host) ?: 'localhost';
    if (extension_loaded('pdo_mysql')) {
        try {
            $dsn = "mysql:host={$h};charset=utf8mb4";
            if (!empty($db)) $dsn .= ";dbname={$db}";
            $pdo = new PDO($dsn, $user, $pass, [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_TIMEOUT => 4,
            ]);
            return true;
        } catch (\Throwable $e) {
            return false;
        }
    }
    if (function_exists('mysqli_connect')) {
        try {
            $link = @mysqli_connect($h, $user, $pass, $db ?: '');
            if ($link) {
                @mysqli_close($link);
                return true;
            }
        } catch (\Throwable $e) {}
    }
    return false;
}

function discoverDbCredentials($dir) {
    $out = ['db_name' => null, 'db_user' => null, 'db_pass' => null, 'db_host' => 'localhost', 'source' => null];
    $docRoot = !empty($_SERVER['DOCUMENT_ROOT']) ? $_SERVER['DOCUMENT_ROOT'] : '';
    $candidates = array_unique(array_filter([
        $dir,
        dirname($dir),
        dirname(dirname($dir)),
        $docRoot,
        $docRoot ? dirname($docRoot) : '',
        $docRoot ? dirname(dirname($docRoot)) : '',
    ]));

    foreach ($candidates as $cdir) {
        if (!is_dir($cdir)) continue;

        // 1. wp-config.php (WordPress install in current, parent, or document root)
        $wp = $cdir . '/wp-config.php';
        if (file_exists($wp)) {
            $c = @file_get_contents($wp);
            if ($c !== false) {
                $found = [];
                if (preg_match("/define\s*\(\s*['\"]DB_NAME['\"]\s*,\s*['\"]([^'\"]+)['\"]/", $c, $m)) $found['db_name'] = $m[1];
                if (preg_match("/define\s*\(\s*['\"]DB_USER['\"]\s*,\s*['\"]([^'\"]+)['\"]/", $c, $m)) $found['db_user'] = $m[1];
                if (preg_match("/define\s*\(\s*['\"]DB_PASSWORD['\"]\s*,\s*['\"]([^'\"]*)['\"]/", $c, $m)) $found['db_pass'] = $m[1];
                if (preg_match("/define\s*\(\s*['\"]DB_HOST['\"]\s*,\s*['\"]([^'\"]+)['\"]/", $c, $m)) $found['db_host'] = $m[1];
                if (!empty($found['db_name']) && !empty($found['db_user'])) {
                    $found['source'] = $wp;
                    if (testDbConnection($found['db_host'] ?? 'localhost', $found['db_user'], $found['db_pass'] ?? '', $found['db_name'])) {
                        return array_merge($out, $found);
                    }
                    if (!$out['db_name']) $out = array_merge($out, $found);
                }
            }
        }

        // 2. .env (Laravel / Slate / other frameworks)
        $env = $cdir . '/.env';
        if (file_exists($env)) {
            $lines = @file($env, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
            if (is_array($lines)) {
                $found = [];
                foreach ($lines as $line) {
                    $t = trim($line);
                    if ($t === '' || $t[0] === '#' || strpos($t, '=') === false) continue;
                    list($k, $v) = explode('=', $t, 2);
                    $k = trim($k); $v = trim($v, " \t\"'");
                    if ($k === 'DB_NAME' && $v !== '') $found['db_name'] = $v;
                    elseif ($k === 'DB_USER' && $v !== '') $found['db_user'] = $v;
                    elseif (($k === 'DB_PASS' || $k === 'DB_PASSWORD') && $v !== '') $found['db_pass'] = $v;
                    elseif ($k === 'DB_HOST' && $v !== '') $found['db_host'] = $v;
                    elseif ($k === 'DB_DATABASE' && empty($found['db_name'])) $found['db_name'] = $v;
                    elseif ($k === 'DB_USERNAME' && empty($found['db_user'])) $found['db_user'] = $v;
                }
                if (!empty($found['db_name']) && !empty($found['db_user'])) {
                    $found['source'] = $env;
                    if (testDbConnection($found['db_host'] ?? 'localhost', $found['db_user'], $found['db_pass'] ?? '', $found['db_name'])) {
                        return array_merge($out, $found);
                    }
                    if (!$out['db_name']) $out = array_merge($out, $found);
                }
            }
        }
    }
    return $out;
}

function splitSqlStatements($sql) {
    $statements = [];
    $inString = false;
    $stringChar = '';
    $current = '';
    $len = strlen($sql);
    for ($i = 0; $i < $len; $i++) {
        $ch = $sql[$i];
        $prev = $i > 0 ? $sql[$i - 1] : '';
        if ($inString) {
            $current .= $ch;
            if ($ch === $stringChar && $prev !== '\\') {
                $inString = false;
            }
            continue;
        }
        if ($ch === "'" || $ch === '"' || $ch === '`') {
            $inString = true;
            $stringChar = $ch;
            $current .= $ch;
            continue;
        }
        if ($ch === ';') {
            $statements[] = $current . ';';
            $current = '';
            continue;
        }
        // strip DELIMITER $$ blocks (used for triggers/routines)
        if ($ch === "\n" && preg_match('/^\s*DELIMITER\s+/i', substr($sql, $i))) {
            $endLine = strpos($sql, "\n", $i + 1);
            if ($endLine === false) $endLine = $len;
            $i = $endLine - 1;
            continue;
        }
        if ($ch === "\n" && preg_match('/^\s*--\s/i', substr($sql, $i))) {
            $endLine = strpos($sql, "\n", $i + 1);
            if ($endLine === false) $endLine = $len;
            $i = $endLine - 1;
            continue;
        }
        $current .= $ch;
    }
    if (trim($current) !== '') $statements[] = $current;
    return $statements;
}

respond(400, [
    'error'          => 'Unknown action "' . $action . '". Valid actions: ' . implode(', ', $GLOBALS['SLATE_SUPPORTED_ACTIONS'] ?? $SLATE_SUPPORTED_ACTIONS ?? ['diagnostics','handshake','cpanel_setup','database_scan','database_create','database_probe','deploy','package_files','download_package','dump_database','sql_import','write_config']) . '.',
    'hint'           => 'If this list is missing actions (sql_import, write_config, package_files, dump_database, download_package, deploy), your deployed auth.php is a STALE/OLD release. Re-download auth.php from the Migration page ("Get auth.php" button) and re-upload it to the target app folder, overwriting the old file.',
    'action_received'=> $action,
    'received_from'  => (isset($_GET['action']) ? 'query_string' : (isset($_POST['action']) ? 'post_form' : (is_array($payload) && isset($payload['action']) ? 'json_payload' : 'default'))),
    'agent_version'  => SLATE_AGENT_VERSION,
]);
