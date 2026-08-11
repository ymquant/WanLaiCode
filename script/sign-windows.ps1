param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $Path
)

$ErrorActionPreference = "Stop"

if (-not $Path -or $Path.Count -eq 0) {
  throw "At least one path is required"
}

if ($env:GITHUB_ACTIONS -ne "true") {
  Write-Host "Skipping Windows signing because this is not running on GitHub Actions"
  exit 0
}

if (-not $env:SIGNCLIENT_KEY) {
  Write-Host "Skipping Windows signing because SIGNCLIENT_KEY is not configured"
  exit 0
}

# 公开 Release 工作流把固定下载地址中的 SignClient 安装到 runner 临时目录，
# 并在使用前核对 SHA-256 和可选的 Authenticode 发布者。
$signClientExe = $env:SIGNCLIENT_PATH
if (-not $signClientExe) {
  throw "SIGNCLIENT_PATH env not set. Install and verify SignClient before packaging."
}
if (-not (Test-Path $signClientExe)) {
  throw "SignClient not found at ${signClientExe}."
}

$env:HTTP_PROXY = $null
$env:HTTPS_PROXY = $null
$env:http_proxy = $null
$env:https_proxy = $null

$files = @($Path | ForEach-Object { Resolve-Path $_ -ErrorAction SilentlyContinue } | Select-Object -ExpandProperty Path -Unique)

if (-not $files -or $files.Count -eq 0) {
  throw "No files matched the requested paths"
}

$signArgs = @("-key", $env:SIGNCLIENT_KEY)
if ($env:SIGNCLIENT_CERT_ID) {
  $signArgs += @("-cert", $env:SIGNCLIENT_CERT_ID)
  Write-Host "Using certificate id: $env:SIGNCLIENT_CERT_ID"
} else {
  Write-Host "SIGNCLIENT_CERT_ID not set, using SignClient default certificate"
}

foreach ($file in $files) {
  Write-Host "Signing $file"
  $output = & $signClientExe $file @signArgs 2>&1
  $output | ForEach-Object { Write-Host $_ }
  if ($LASTEXITCODE -ne 0) {
    $joined = ($output | Out-String).Trim()
    throw "SignClient failed (exit $LASTEXITCODE) for ${file}: $joined"
  }
}
