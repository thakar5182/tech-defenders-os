[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BackupDir,
  [string]$BaseUrl = 'https://tech-defenders-os-dkyf.onrender.com'
)

$ErrorActionPreference = 'Stop'
$token = [Environment]::GetEnvironmentVariable('TDOS_BACKUP_AGENT_TOKEN', 'User')
if ([string]::IsNullOrWhiteSpace($token)) {
  throw 'TDOS_BACKUP_AGENT_TOKEN is not configured for this Windows user.'
}
if (!(Test-Path -LiteralPath $BackupDir)) {
  New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$temp = Join-Path $BackupDir ('.tdos-download-' + $stamp + '.tmp')
$target = Join-Path $BackupDir ('tdos-system-' + $stamp + '.enc')
try {
  Invoke-WebRequest -Uri ($BaseUrl.TrimEnd('/') + '/api/backups/agent/export') `
    -Headers @{ 'X-Backup-Agent-Token' = $token } `
    -OutFile $temp `
    -UseBasicParsing
  if ((Get-Item -LiteralPath $temp).Length -lt 64) { throw 'Downloaded backup is unexpectedly small.' }
  Move-Item -LiteralPath $temp -Destination $target -Force
  $saved = Get-Item -LiteralPath $target
  Invoke-RestMethod -Method Post -Uri ($BaseUrl.TrimEnd('/') + '/api/backups/agent/heartbeat') `
    -Headers @{ 'X-Backup-Agent-Token' = $token } `
    -ContentType 'application/json' `
    -Body (@{ status = 'success'; fileName = $saved.Name; sizeBytes = $saved.Length } | ConvertTo-Json) | Out-Null
  Write-Host ('Encrypted backup saved: ' + $target) -ForegroundColor Green
} finally {
  if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
}
