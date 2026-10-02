param(
  [string]$GameRoot = "E:\GAME\Wayward"
)

$ErrorActionPreference = "Stop"

$backendRoot = Join-Path $GameRoot "wayward-imagegen"
$gameEntry   = Join-Path $GameRoot "index.html"
$stateDir    = Join-Path $backendRoot "images\.state"
$stdoutLog   = Join-Path $stateDir "launcher-backend.out.log"
$stderrLog   = Join-Path $stateDir "launcher-backend.err.log"

function Test-Http([string]$Url, [int]$TimeoutSec = 2) {
  try {
    $null = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec
    return $true
  }
  catch {
    return $false
  }
}

if (-not (Test-Path $gameEntry)) {
  throw "Wayward entry point not found: $gameEntry"
}
if (-not (Test-Path (Join-Path $backendRoot "src\cli.ts"))) {
  throw "wayward-imagegen backend not found: $backendRoot"
}

if (-not (Test-Http "http://127.0.0.1:8188/system_stats" 3)) {
  Write-Host ""
  Write-Host "ComfyUI is not running at http://127.0.0.1:8188." -ForegroundColor Yellow
  Write-Host "Start ComfyUI first, then run Wayward-AI.cmd again."
  exit 2
}

$backendReady = Test-Http "http://127.0.0.1:8189/api/pack" 2

if (-not $backendReady) {
  $port = Get-NetTCPConnection -LocalPort 8189 -State Listen -ErrorAction SilentlyContinue
  if ($port) {
    throw "Port 8189 is in use, but the Wayward image backend did not answer /api/pack."
  }

  $bun = Get-Command bun -ErrorAction SilentlyContinue
  if (-not $bun) {
    throw "Bun was not found in PATH. Install/configure Bun before launching Wayward."
  }

  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

  # Get-Command bun can resolve to a PowerShell shim/script rather than bun.exe.
  # Passing that shim directly to Start-Process raises
  # "%1 is not a valid Win32 application" on some Bun installations.
  # Launch it through PowerShell so the same command resolution that works in
  # the user's terminal is used here as well.
  $bunCommand = "& bun 'src\cli.ts' --verbose"

  Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $bunCommand) `
    -WorkingDirectory $backendRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog | Out-Null

  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 400
    $backendReady = Test-Http "http://127.0.0.1:8189/api/pack" 2
  } while (-not $backendReady -and (Get-Date) -lt $deadline)

  if (-not $backendReady) {
    throw "wayward-imagegen did not become ready. Check: $stderrLog"
  }
}

Start-Process $gameEntry
