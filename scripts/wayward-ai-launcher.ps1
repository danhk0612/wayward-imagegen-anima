param(
  [string]$GameRoot = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($GameRoot)) {
  $GameRoot = $PSScriptRoot
}

$backendRoot = Join-Path $GameRoot "wayward-imagegen"
$gameEntry   = Join-Path $GameRoot "index.html"
$configPath  = Join-Path $backendRoot "wayward-imagegen.config.json"
$stateDir    = Join-Path $backendRoot "images\.state"
$stdoutLog   = Join-Path $stateDir "launcher-backend.out.log"
$stderrLog   = Join-Path $stateDir "launcher-backend.err.log"
$backendBase = "http://127.0.0.1:8189"
$trayScript  = Join-Path $GameRoot "Wayward-Anima-Tray.ps1"

function Test-Http([string]$Url, [int]$TimeoutSec = 2) {
  try {
    $null = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec
    return $true
  }
  catch {
    return $false
  }
}

function Read-LauncherConfig {
  if (-not (Test-Path $configPath)) { return $null }
  try {
    return Get-Content $configPath -Raw | ConvertFrom-Json
  }
  catch {
    return $null
  }
}

function Get-ComfyUrl {
  $cfg = Read-LauncherConfig
  if ($cfg -and -not [string]::IsNullOrWhiteSpace([string]$cfg.comfyUrl)) {
    return ([string]$cfg.comfyUrl).TrimEnd("/")
  }
  return "http://127.0.0.1:8188"
}

function Test-SetupRequired {
  $cfg = Read-LauncherConfig
  if (-not $cfg) { return $true }

  $profileCount = 0
  if ($cfg.characterProfiles) {
    $profileCount = @($cfg.characterProfiles.PSObject.Properties).Count
  }
  return ($cfg.imagePreset -ne "anima") -or ($profileCount -lt 1)
}

function Get-PortOwner {
  return Get-NetTCPConnection -LocalPort 8189 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

function Get-BackendIdentity {
  $port = Get-PortOwner
  if (-not $port) {
    return [PSCustomObject]@{
      Running = $false
      Owned = $false
      Legacy = $false
      Busy = $false
      Pid = $null
      ConfigPath = $null
      Error = $null
    }
  }

  $control = $null
  $reported = $null
  $legacy = $false
  $probeError = $null

  try {
    $control = Invoke-RestMethod -Uri ($backendBase + "/api/control/status") -TimeoutSec 3
    if ($control.instance -and -not [string]::IsNullOrWhiteSpace([string]$control.instance.configPath)) {
      $reported = [System.IO.Path]::GetFullPath([string]$control.instance.configPath)
    }
    else {
      $legacy = $true
    }
  }
  catch {
    $legacy = $true
    $probeError = $_.Exception.Message
  }

  if (-not $reported) {
    try {
      $setup = Invoke-RestMethod -Uri ($backendBase + "/api/setup/settings") -TimeoutSec 3
      if (-not [string]::IsNullOrWhiteSpace([string]$setup.configPath)) {
        $reported = [System.IO.Path]::GetFullPath([string]$setup.configPath)
      }
    }
    catch {
      if (-not $probeError) { $probeError = $_.Exception.Message }
    }
  }

  if ($reported) {
    $expected = [System.IO.Path]::GetFullPath($configPath)
    $owned = [string]::Equals($reported, $expected, [System.StringComparison]::OrdinalIgnoreCase)
    $busy = $false
    if ($control) {
      $busy = (@($control.activeJobs).Count -gt 0) -or [bool]$control.batch.running
    }
    return [PSCustomObject]@{
      Running = $true
      Owned = $owned
      Legacy = $legacy
      Busy = $busy
      Pid = $port.OwningProcess
      ConfigPath = $reported
      Error = $probeError
    }
  }

  return [PSCustomObject]@{
    Running = $true
    Owned = $false
    Legacy = $legacy
    Busy = $false
    Pid = $port.OwningProcess
    ConfigPath = $null
    Error = $probeError
  }
}

function Start-Backend {
  $identity = Get-BackendIdentity
  if ($identity.Running) {
    if (-not $identity.Owned) {
      throw "Port 8189 is already used by another/unknown backend (PID $($identity.Pid))."
    }
    if (-not $identity.Legacy) {
      return
    }
    if ($identity.Busy) {
      throw "An older backend for this Wayward installation is still doing AI work. Wait for it to finish or pause/cancel it before restarting."
    }

    Write-Host "Older owned backend detected. Restarting it with the current package..." -ForegroundColor Yellow
    Stop-Backend
  }

  $port = Get-PortOwner
  if ($port) {
    throw "Port 8189 is in use, but ownership could not be established safely."
  }

  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

  if (Test-Path $backendExe) {
    Start-Process `
      -FilePath $backendExe `
      -ArgumentList @("--verbose") `
      -WorkingDirectory $backendRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutLog `
      -RedirectStandardError $stderrLog | Out-Null
  }
  else {
    $bun = Get-Command bun -ErrorAction SilentlyContinue
    if (-not $bun) {
      throw "Bun was not found in PATH. Install/configure Bun or use the Portable package."
    }

    # Get-Command bun may resolve to a PowerShell shim instead of bun.exe.
    # Resolve it inside a child PowerShell so both installations work.
    $bunCommand = "& bun 'src\cli.ts' --verbose"

    Start-Process `
      -FilePath "powershell.exe" `
      -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $bunCommand) `
      -WorkingDirectory $backendRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutLog `
      -RedirectStandardError $stderrLog | Out-Null
  }

  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 400
    if (Test-Http ($backendBase + "/api/pack") 2) { return }
  } while ((Get-Date) -lt $deadline)

  throw "wayward-imagegen did not become ready. Check: $stderrLog"
}

function Start-Tray {
  if (-not (Test-Path $trayScript)) { return }

  $quotedTray = '"' + $trayScript + '"'
  $quotedRoot = '"' + $GameRoot + '"'
  Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $quotedTray, "-GameRoot", $quotedRoot) `
    -WorkingDirectory $GameRoot `
    -WindowStyle Hidden | Out-Null
}

function Stop-Backend {
  $identity = Get-BackendIdentity
  if (-not $identity.Running) { return }
  if (-not $identity.Owned) {
    throw "Refusing to stop PID $($identity.Pid): port 8189 does not belong to this Wayward installation."
  }

  try {
    Invoke-RestMethod `
      -Uri ($backendBase + "/api/control/shutdown") `
      -Method Post `
      -TimeoutSec 5 | Out-Null
  }
  catch {
    throw "The backend is running but could not be shut down safely. Open $backendBase/setup.html and use AI server shutdown."
  }

  $deadline = (Get-Date).AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 300
    if (-not (Get-PortOwner)) { return }
  } while ((Get-Date) -lt $deadline)

  throw "The backend did not stop within 15 seconds."
}

if (-not (Test-Path $gameEntry)) {
  throw "Wayward entry point not found: $gameEntry"
}
$backendExe = Join-Path $backendRoot "wayward-imagegen.exe"
$backendCli = Join-Path $backendRoot "src\cli.ts"
if (-not (Test-Path $backendExe) -and -not (Test-Path $backendCli)) {
  throw "wayward-imagegen backend not found: $backendRoot"
}

$comfyUrl = Get-ComfyUrl
if (-not (Test-Http ($comfyUrl + "/system_stats") 3)) {
  Write-Host ""
  Write-Host "ComfyUI is not answering at $comfyUrl." -ForegroundColor Yellow
  Write-Host "The backend will still start so setup/review remains available."
}

Start-Backend
Start-Tray

if (Test-SetupRequired) {
  Start-Process ($backendBase + "/setup.html")
  Write-Host ""
  Write-Host "Initial Anima setup is required." -ForegroundColor Cyan
  Write-Host "The setup page is open. This launcher will wait for you to save a character profile."
  Write-Host "After a valid setup is saved, the backend will restart once and Wayward will open automatically."

  $deadline = (Get-Date).AddHours(2)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    if (-not (Test-SetupRequired)) {
      Write-Host "Setup saved. Restarting image backend..."
      Stop-Backend
      Start-Backend
      break
    }
  }

  if (Test-SetupRequired) {
    throw "Setup was not completed within two hours. Run Wayward-Anima.cmd again when ready."
  }
}

$comfyUrl = Get-ComfyUrl
if (-not (Test-Http ($comfyUrl + "/system_stats") 3)) {
  Write-Host "ComfyUI is still unavailable at $comfyUrl. Cached art can be used, but new images cannot render." -ForegroundColor Yellow
}

Start-Process $gameEntry

Write-Host ""
Write-Host "Wayward opened. The image backend keeps running after the game/browser closes." -ForegroundColor Cyan
Write-Host "The tray icon shows backend state and provides start/stop/restart/setup/game actions."
Write-Host "Wayward-Anima-Server.cmd remains available as the console server manager."
