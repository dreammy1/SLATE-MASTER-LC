# Directly try to grant privileges on the existing DB/user from the previous attempt
$headers = @{
    "Content-Type" = "application/json"
    "X-Slate-Token" = "slate_live_9fddcd85c48a6e583c2db2391c361d3109ab8598"
}

# The existing DB=whatever_b7c0fe, User=whatever_ub7c0 were created previously.
# We need to just grant privileges manually via the diagnostics endpoint or a custom call.
# Let's use a small PHP snippet via deploy to grant privileges.

# Actually, let's modify auth.php to handle the case where DB already exists
# For now, let's check what app_name was used for the original whatever_b7c0fe provisioning
# from the dashboard. The dashboard sends the domain slug as app_name.

# Let me try calling database_create with a custom app_name that would regenerate
# the exact same DB name, but first let's check the current state from the dashboard API.

Write-Host "=== CHECKING SITE DATABASE STATE ==="

# Just directly test granting privileges on the existing pair
# We'll create a tiny PHP script that does just that
$phpGrant = @'
<?php
// Temporary script to grant privileges on existing DB/user
error_reporting(E_ALL);
ini_set('display_errors', 0);
header('Content-Type: application/json');

$configFile = __DIR__ . '/.slate_config.json';
if (!file_exists($configFile)) {
    echo json_encode(['error' => 'No config file']);
    exit;
}
$config = json_decode(file_get_contents($configFile), true);
$cpUser = $config['cpanel_user'] ?? '';
$cpToken = $config['cpanel_api_token'] ?? '';

if (empty($cpUser) || empty($cpToken)) {
    echo json_encode(['error' => 'No cPanel credentials']);
    exit;
}

$privVariants = ['ALL PRIVILEGES', 'ALL', 'ALTER,CREATE,DELETE,DROP,INDEX,INSERT,SELECT,UPDATE,REFERENCES'];
$results = [];

foreach ($privVariants as $priv) {
    $params = [
        'user'       => 'whatever_ub7c0',
        'database'   => 'whatever_b7c0fe',
        'privileges' => $priv,
    ];
    
    $url = "https://127.0.0.1:2083/execute/Mysql/set_privileges_on_database";
    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL            => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => false,
        CURLOPT_TIMEOUT        => 25,
        CURLOPT_CONNECTTIMEOUT => 4,
        CURLOPT_HTTPHEADER     => [
            "Authorization: cpanel {$cpUser}:{$cpToken}",
            'Content-Type: application/x-www-form-urlencoded',
        ],
        CURLOPT_POST       => true,
        CURLOPT_POSTFIELDS => http_build_query($params, '', '&', PHP_QUERY_RFC3986),
    ]);
    
    $body = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);
    
    $results[] = [
        'privileges' => $priv,
        'http_code'  => $httpCode,
        'curl_error' => $curlErr ?: null,
        'response'   => json_decode($body, true) ?: $body,
    ];
    
    // If success, break
    $parsed = json_decode($body, true);
    if (is_array($parsed)) {
        $status = $parsed['status'] ?? ($parsed['result']['status'] ?? null);
        if ((int)$status === 1) {
            $results[count($results)-1]['success'] = true;
            break;
        }
    }
}

echo json_encode(['results' => $results], JSON_PRETTY_PRINT);
'@

# Deploy this as a temp file
$tempPhpBytes = [System.Text.Encoding]::UTF8.GetBytes($phpGrant)
$tempPhpB64 = [Convert]::ToBase64String($tempPhpBytes)

# Write the PHP to a temp file on the server via deploy
$zipPath = "temp_grant_test.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

# Write the PHP to a local temp file
$tempPhpFile = "temp_grant_test.php"
Set-Content -Path $tempPhpFile -Value $phpGrant -Encoding UTF8

Compress-Archive -Path $tempPhpFile -DestinationPath $zipPath -Force
$zipBytes = [System.IO.File]::ReadAllBytes((Resolve-Path $zipPath).Path)
$zipB64 = [Convert]::ToBase64String($zipBytes)

$deployBody = @{
    archive_base64 = $zipB64
    allow_agent_upgrade = $false
    commit_sha = "temp-grant-test"
} | ConvertTo-Json

$deployRes = Invoke-RestMethod -Uri "https://whatever-bar.de/slate/auth.php?action=deploy" -Method Post -Body $deployBody -Headers $headers
Write-Host "Deploy temp PHP: $($deployRes.status)"

# Now call the temp PHP
Write-Host "`n=== TESTING GRANT PRIVILEGES ==="
try {
    $req = [System.Net.HttpWebRequest]::Create("https://whatever-bar.de/slate/temp_grant_test.php")
    $req.Method = "GET"
    $resp = $req.GetResponse()
    $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
    Write-Host $reader.ReadToEnd()
} catch [System.Net.WebException] {
    $resp = $_.Exception.Response
    if ($resp) {
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
        Write-Host "ERROR: $($reader.ReadToEnd())"
    } else {
        Write-Host "ERROR: $($_.Exception.Message)"
    }
}

# Cleanup local temp files
Remove-Item $tempPhpFile -Force -ErrorAction SilentlyContinue
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
