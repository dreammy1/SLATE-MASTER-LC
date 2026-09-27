<?php
/**
 * Slate — Master-driven NON-INTERACTIVE installer (Phase B).
 *
 * Deployed by SLATE Master OS together with auth.php, BEFORE the full app
 * exists. After Master copies the release files + writes .env, it calls this
 * endpoint once to finish the install headlessly:
 *
 *   1. connect using the DB_* credentials Master just wrote into .env
 *   2. run the core + licensing migrations (MigrationRunner, ledger-safe)
 *   3. create the first admin user
 *   4. activate the plugins included in the client's package
 *   5. write the .installed marker so install.php never shows its wizard
 *
 * Contract (JSON only, never HTML):
 *   GET  ?action=status                  -> {status, installed, db_ok, migrations{...}}
 *   POST ?action=install {admin_email, admin_name, admin_password, plugins[]}
 *                                        -> {status:"INSTALLED", ...} | {error:"..."}
 *
 * Auth: identical to auth.php — X-Slate-Token header (or `token` in body)
 * verified against token_hash in .slate_agent_config.json. When the agent has
 * not been paired yet the endpoint is open, exactly like authenticateAgent().
 *
 * Idempotent: re-running after a partial failure continues where it stopped
 * (migrations are ledger-guarded, the admin user is only created when the
 * users table is empty) so Master's "Retry automation" is always safe.
 *
 * Version: 1.0.0
 */

declare(strict_types=1);

@ini_set('display_errors', '0');
@ini_set('display_startup_errors', '0');
error_reporting(E_ALL);

define('SLATE_INSTALLER_VERSION', '1.0.0');

/** Everything leaves this script as JSON, including fatals. */
function installerRespond(int $code, array $payload): void
{
    if (!headers_sent()) {
        http_response_code($code);
        header('Content-Type: application/json; charset=utf-8');
        header('X-Slate-Installer: ' . SLATE_INSTALLER_VERSION);
        header('Cache-Control: no-store');
    }
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function installerConfigPath(): string
{
    return __DIR__ . '/.slate_agent_config.json';
}

function installerLoadConfig(): array
{
    if (!file_exists(installerConfigPath())) {
        return [];
    }
    $raw = @file_get_contents(installerConfigPath());
    return $raw ? (json_decode($raw, true) ?: []) : [];
}

/* ── Request body (JSON or form) ─────────────────────────────────── */
$rawBody = @file_get_contents('php://input');
$body    = [];
if (is_string($rawBody) && $rawBody !== '') {
    $decoded = json_decode($rawBody, true);
    if (is_array($decoded)) {
        $body = $decoded;
    }
}
if (!$body && !empty($_POST)) {
    $body = $_POST;
}

/* ── Token gate (mirrors auth.php authenticateAgent) ─────────────── */
$token  = $_SERVER['HTTP_X_SLATE_TOKEN'] ?? ($body['token'] ?? '');
$config = installerLoadConfig();
if (!empty($config['token_hash'])) {
    if (empty($token) || !password_verify((string)$token, (string)$config['token_hash'])) {
        installerRespond(401, ['error' => 'Unauthorized: invalid SLATE agent token.']);
    }
}

$action = strtolower(trim((string)($_GET['action'] ?? $body['action'] ?? 'install')));

/* ── Read .env written by Master's write_config ──────────────────── */
$envPath = __DIR__ . '/.env';
$env     = [];
if (file_exists($envPath)) {
    foreach (file($envPath, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#') || !str_contains($line, '=')) {
            continue;
        }
        [$k, $v] = explode('=', $line, 2);
        $env[trim($k)] = trim($v, " \t\n\r\0\x0B\"'");
    }
} else {
    installerRespond(400, [
        'error' => 'No .env on the server yet — Master must write the database configuration before installing.',
        'hint'  => 'Re-run the bootstrap / full-install from Master; it writes .env with DB_HOST/DB_NAME/DB_USER/DB_PASS first.',
    ]);
}

/* ── Constants the Slate classes require ─────────────────────────── */
if (!defined('SLATE_ROOT'))    define('SLATE_ROOT', __DIR__);
if (!defined('SLATE_VERSION')) define('SLATE_VERSION', '1.0.0');
if (!defined('DB_HOST'))       define('DB_HOST',    $env['DB_HOST']    ?? 'localhost');
if (!defined('DB_PORT'))       define('DB_PORT',    $env['DB_PORT']    ?? '');
if (!defined('DB_NAME'))       define('DB_NAME',    $env['DB_NAME']    ?? '');
if (!defined('DB_USER'))       define('DB_USER',    $env['DB_USER']    ?? '');
if (!defined('DB_PASS'))       define('DB_PASS',    $env['DB_PASS']    ?? '');
if (!defined('DB_CHARSET'))    define('DB_CHARSET', $env['DB_CHARSET'] ?? 'utf8mb4');
if (!defined('SLATE_URL'))     define('SLATE_URL',  rtrim($env['APP_URL'] ?? '', '/'));
if (!defined('TENANT_ID'))     define('TENANT_ID',  (int)($env['TENANT_ID'] ?? 1));
if (!defined('APP_SECRET'))    define('APP_SECRET', $env['APP_SECRET'] ?? '');
if (!defined('CRON_SECRET'))   define('CRON_SECRET', $env['CRON_SECRET'] ?? '');
if (!defined('MCP_GATEWAY_ENABLED')) {
    define('MCP_GATEWAY_ENABLED', ($env['MCP_GATEWAY_ENABLED'] ?? '0') === '1');
}

if (DB_NAME === '' || DB_USER === '') {
    installerRespond(400, [
        'error' => '.env is missing DB_NAME / DB_USER, so the installer cannot connect.',
        'hint'  => 'Re-run the install from Master: it rewrites .env with the correct database credentials.',
    ]);
}

/* ── App bootstrap (autoloader only — NOT config.php, which would start a
       session, redirect on force_https and boot plugins mid-install) ── */
$bootstrapFiles = [
    SLATE_ROOT . '/includes/helpers.php',
    SLATE_ROOT . '/src/autoload.php',
    SLATE_ROOT . '/src/compat/aliases.php',
];
foreach ($bootstrapFiles as $bootstrapFile) {
    if (!is_file($bootstrapFile)) {
        installerRespond(500, [
            'error' => 'Application files are incomplete: ' . str_replace(SLATE_ROOT, '', $bootstrapFile) . ' is missing.',
            'hint'  => 'The release copy did not finish. Retry the install from Master — already-copied files are skipped.',
        ]);
    }
    require_once $bootstrapFile;
}

/* ── Migrations this headless install must apply ─────────────────── */
$MIGRATION_PLAN = [
    // Core spine (same set the interactive wizard uses)
    '0001_core_init',
    '0002_identity_core',
    '0011_login_attempts',
    // Licensing / plans (a Master-driven install is always a licensed install)
    '0014_tenant_profiles',
    '0015_platform_plans',
    '0016_tenant_plan_assignment',
    '0017_licenses',
    '0021_license_domains',
    '0022_package_restrictions',
];

function installerConnect(): \PDO
{
    try {
        return \Slate\Data\Database::get();
    } catch (\Throwable $e) {
        installerRespond(500, [
            'error' => 'Database connection failed: ' . $e->getMessage(),
            'hint'  => 'Open cPanel > MySQL Databases and confirm ' . DB_NAME . ' exists and ' . DB_USER
                     . ' is attached to it with ALL PRIVILEGES, then press Retry automation.',
        ]);
    }
}

function installerRunner(\PDO $pdo): \Slate\Data\MigrationRunner
{
    return new \Slate\Data\MigrationRunner($pdo, SLATE_ROOT . '/db/migrations');
}

/* ── action=status : read-only diagnostics ───────────────────────── */
if ($action === 'status') {
    $applied   = [];
    $pending   = [];
    $userCount = null;
    $dbOk      = false;
    $dbError   = null;

    try {
        $pdo       = \Slate\Data\Database::get();
        $dbOk      = true;
        $runner    = installerRunner($pdo);
        $applied   = $runner->applied();
        $pending   = array_values(array_intersect($runner->pending(), $MIGRATION_PLAN));
        $userCount = (int) $pdo->query('SELECT COUNT(*) FROM users')->fetchColumn();
    } catch (\Throwable $e) {
        $dbError = $e->getMessage();
    }

    installerRespond(200, [
        'status'          => 'OK',
        'installer'       => SLATE_INSTALLER_VERSION,
        'installed'       => file_exists(__DIR__ . '/.installed'),
        'db_ok'           => $dbOk,
        'db_error'        => $dbError,
        'db_name'         => DB_NAME,
        'db_user'         => DB_USER,
        'site_url'        => SLATE_URL,
        'migrations'      => ['applied' => count($applied), 'pending_relevant' => $pending],
        'admin_user'      => $userCount,
        'license_key_set' => !empty($env['LICENSE_KEY']),
    ]);
}

/* ── action=install : the headless install ───────────────────────── */
$warnings = [];
$report   = ['migrations' => [], 'plugins' => [], 'steps' => []];

$alreadyInstalled = file_exists(__DIR__ . '/.installed');

$adminEmail    = trim((string)($body['admin_email'] ?? ''));
$adminName     = trim((string)($body['admin_name'] ?? 'Site Owner'));
$adminPassword = (string)($body['admin_password'] ?? '');
$pluginSlugs   = array_values(array_filter(array_map('strval', (array)($body['plugins'] ?? []))));
$force         = !empty($body['force']);

$pdo = installerConnect();

/* 1 ─ migrations */
try {
    $runner  = installerRunner($pdo);
    $onDisk  = $runner->discover();
    $toRun   = array_values(array_intersect($MIGRATION_PLAN, $onDisk));
    $missing = array_values(array_diff($MIGRATION_PLAN, $onDisk));
    if ($missing) {
        $warnings[] = 'Migration files not present on disk: ' . implode(', ', $missing);
    }
    $ran = $runner->migrate($toRun);
    $report['migrations'] = ['ran' => $ran, 'already_applied' => array_values(array_diff($toRun, $ran))];
    $report['steps'][]    = 'schema:' . count($ran) . ' applied';
} catch (\Throwable $e) {
    installerRespond(500, [
        'error'   => 'Running the database migrations failed: ' . $e->getMessage(),
        'hint'    => 'Check the MySQL user has CREATE/ALTER rights on ' . DB_NAME
                   . '. If the error mentions a table that already exists, the install was partially done before — press Retry automation, applied migrations are skipped.',
        'partial' => $report,
    ]);
}

/* 2 ─ first admin user */
try {
    $userCount = (int) $pdo->query('SELECT COUNT(*) FROM users')->fetchColumn();
    if ($userCount === 0) {
        if ($adminEmail === '' || !filter_var($adminEmail, FILTER_VALIDATE_EMAIL)) {
            installerRespond(400, [
                'error'   => 'A valid admin email is required to create the first administrator.',
                'hint'    => 'Set the contact email on the order in Master, then press Retry automation.',
                'partial' => $report,
            ]);
        }
        $generated = false;
        if ($adminPassword === '') {
            $adminPassword = bin2hex(random_bytes(6));
            $generated     = true;
            $warnings[]    = 'No admin password was supplied — a temporary one was generated. Use "Forgot password" on the login page to set your own.';
        }
        \Slate\Data\Database::insert('users', [
            'tenant_id'     => 1,
            'email'         => $adminEmail,
            'password_hash' => password_hash($adminPassword, PASSWORD_DEFAULT),
            'name'          => $adminName !== '' ? $adminName : 'Site Owner',
            'role_id'       => 1,
            'status'        => 'active',
        ]);
        $report['steps'][]     = 'admin_created';
        $report['admin_user']  = $adminEmail;
        $report['admin_temp']  = $generated ? $adminPassword : null;
    } else {
        $report['steps'][] = 'admin_exists(' . $userCount . ')';
    }
} catch (\Throwable $e) {
    installerRespond(500, [
        'error'   => 'Creating the administrator account failed: ' . $e->getMessage(),
        'hint'    => 'Confirm the migrations above ran. If the users table is missing, press Retry automation.',
        'partial' => $report,
    ]);
}

/* 3 ─ activate the client's package plugins */
if ($pluginSlugs) {
    foreach ($pluginSlugs as $slug) {
        $slug = preg_replace('/[^A-Za-z0-9_\-]/', '', (string)$slug);
        if ($slug === '') {
            continue;
        }
        try {
            $res = \Slate\Kernel\Module\PluginLoader::installFromDisk($slug);
            $ok  = !empty($res['ok']);
            $report['plugins'][] = ['slug' => $slug, 'ok' => $ok, 'error' => $res['error'] ?? null];
            if (!$ok) {
                $warnings[] = "Plugin '{$slug}' could not be activated: " . ($res['error'] ?? 'unknown reason')
                            . ' — activate it from Admin > Plugins after you log in.';
            }
        } catch (\Throwable $e) {
            $report['plugins'][] = ['slug' => $slug, 'ok' => false, 'error' => $e->getMessage()];
            $warnings[] = "Plugin '{$slug}' threw during activation: " . $e->getMessage()
                        . ' — activate it from Admin > Plugins after you log in.';
        }
    }
    $report['steps'][] = 'plugins:' . count($report['plugins']);
}

/* 4 ─ .installed marker (skips the interactive wizard) */
if (!$alreadyInstalled || $force) {
    $marker = @file_put_contents(
        __DIR__ . '/.installed',
        'Installed: ' . date('Y-m-d H:i:s') . ' | Slate ' . SLATE_VERSION . " | installed by SLATE Master OS\n"
    );
    if ($marker === false) {
        $warnings[] = '.installed could not be written (the folder is not writable), so your site may show the install wizard once. Make the folder writable and press Retry automation — your database is already set up.';
    } else {
        @chmod(__DIR__ . '/.installed', 0640);
        $report['steps'][] = 'marker_written';
    }
}

$loginUrl = (SLATE_URL !== '' ? SLATE_URL : '') . '/admin/login.php';

installerRespond(200, [
    'status'     => 'INSTALLED',
    'installer'  => SLATE_INSTALLER_VERSION,
    'already'    => $alreadyInstalled,
    'message'    => $alreadyInstalled
        ? 'Slate was already installed — verification finished.'
        : 'Slate installed successfully. Log in with your admin account.',
    'site_url'   => SLATE_URL,
    'login_url'  => $loginUrl,
    'migrations' => $report['migrations'],
    'plugins'    => $report['plugins'],
    'steps'      => $report['steps'],
    'warnings'   => $warnings,
    'admin_user' => $report['admin_user'] ?? null,
    'admin_temp_password' => $report['admin_temp'] ?? null,
]);
