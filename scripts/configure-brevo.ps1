param([switch]$Force)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $ProjectRoot '.env'

if (-not (Test-Path -LiteralPath $EnvFile)) {
    & node (Join-Path $PSScriptRoot 'create-env.js')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$AlreadyConfigured = Select-String -LiteralPath $EnvFile -Pattern '^BREVO_API_KEY=.+$' -Quiet
if ($AlreadyConfigured -and -not $Force) {
    Write-Host '[brevo] Existing Brevo API key preserved.' -ForegroundColor Green
    Write-Host '[brevo] Run CONFIGURE-BREVO.bat manually if the key must be replaced.'
    exit 0
}

Write-Host ''
Write-Host 'Brevo sender: Tech Defenders <techdefenderss@gmail.com>' -ForegroundColor Cyan
Write-Host 'Paste the API key saved from Brevo. Input stays hidden.'
$SecureKey = Read-Host 'Brevo API key (press Enter to skip)' -AsSecureString
$Bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureKey)
$PlainKey = $null

try {
    $PlainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr)
    if ([string]::IsNullOrWhiteSpace($PlainKey)) {
        Write-Host '[brevo] Skipped. Password login still works; email OTP needs this key.' -ForegroundColor Yellow
        exit 0
    }
    $PlainKey | & node (Join-Path $PSScriptRoot 'configure-brevo.js')
    exit $LASTEXITCODE
}
finally {
    $PlainKey = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr)
    $SecureKey.Dispose()
}

