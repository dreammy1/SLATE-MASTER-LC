$authPhp = "public\auth.php"
$tempZip = "temp_deploy_agent.zip"

if (Test-Path $tempZip) { Remove-Item $tempZip -Force }

Compress-Archive -Path $authPhp -DestinationPath $tempZip -Force

$bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $tempZip).Path)
$b64 = [Convert]::ToBase64String($bytes)
Remove-Item $tempZip -Force

$body = @{
    archive_base64 = $b64
    allow_agent_upgrade = $true
    commit_sha = "patch-grant-privileges-fallback"
} | ConvertTo-Json

$headers = @{
    "Content-Type" = "application/json"
    "X-Slate-Token" = "slate_live_9fddcd85c48a6e583c2db2391c361d3109ab8598"
}

try {
    $res = Invoke-RestMethod -Uri "https://whatever-bar.de/slate/auth.php?action=deploy" -Method Post -Body $body -Headers $headers
    $res | ConvertTo-Json -Depth 5
} catch {
    Write-Host "ERROR: $($_.Exception.Message)"
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $reader.BaseStream.Position = 0
        Write-Host $reader.ReadToEnd()
    }
}
