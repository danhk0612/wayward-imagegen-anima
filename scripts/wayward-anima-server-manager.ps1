param(
  [ValidateSet("Menu", "Status", "Start", "Stop", "Restart", "Setup", "Game")]
  [string]$Action = "Menu",
  [string]$GameRoot = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($GameRoot)) {
  $GameRoot = $PSScriptRoot
}
$GameRoot = [System.IO.Path]::GetFullPath($GameRoot)

$backendRoot = Join-Path $GameRoot "wayward-imagegen"
$configPath = Join-Path $backendRoot "wayward-imagegen.config.json"
$backendExe = Join-Path $backendRoot "wayward-imagegen.exe"
$backendCli = Join-Path $backendRoot "src\cli.ts"
$launcherCmd = Join-Path $GameRoot "Wayward-Anima.cmd"
$backendBase = "http://127.0.0.1:8189"

function Test-Http([string]$Url, [int]$TimeoutSec = 2) {
  try {
    $null = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec
    return $true
  }
  catch {
    return $false
  }
}

function Read-Config {
  if (-not (Test-Path $configPath)) { return $null }
  try {
    return Get-Content $configPath -Raw | ConvertFrom-Json
  }
  catch {
    return $null
  }
}

function Resolve-BackendPath([string]$Value, [string]$Fallback) {
  $raw = $Value
  if ([string]::IsNullOrWhiteSpace($raw)) { $raw = $Fallback }
  if ([System.IO.Path]::IsPathRooted($raw)) {
    return [System.IO.Path]::GetFullPath($raw)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $backendRoot $raw))
}

function Get-StateDir {
  $cfg = Read-Config
  if ($cfg -and ($cfg.PSObject.Properties.Name -contains "stateDir")) {
    return Resolve-BackendPath ([string]$cfg.stateDir) "images\.state"
  }
  return Resolve-BackendPath "" "images\.state"
}

function Get-ComfyUrl {
  $cfg = Read-Config
  if ($cfg -and -not [string]::IsNullOrWhiteSpace([string]$cfg.comfyUrl)) {
    return ([string]$cfg.comfyUrl).TrimEnd("/")
  }
  return "http://127.0.0.1:8188"
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
      Pid = $null
      ConfigPath = $null
      Error = $null
    }
  }

  try {
    $setup = Invoke-RestMethod -Uri ($backendBase + "/api/setup/settings") -TimeoutSec 3
    $reported = [System.IO.Path]::GetFullPath([string]$setup.configPath)
    $expected = [System.IO.Path]::GetFullPath($configPath)
    $owned = [string]::Equals($reported, $expected, [System.StringComparison]::OrdinalIgnoreCase)
    return [PSCustomObject]@{
      Running = $true
      Owned = $owned
      Pid = $port.OwningProcess
      ConfigPath = $reported
      Error = $null
    }
  }
  catch {
    return [PSCustomObject]@{
      Running = $true
      Owned = $false
      Pid = $port.OwningProcess
      ConfigPath = $null
      Error = $_.Exception.Message
    }
  }
}

function Get-ControlStatus {
  try {
    return Invoke-RestMethod -Uri ($backendBase + "/api/control/status") -TimeoutSec 3
  }
  catch {
    return $null
  }
}

function Show-Status {
  $identity = Get-BackendIdentity
  $comfyUrl = Get-ComfyUrl
  $comfy = Test-Http ($comfyUrl + "/system_stats") 2

  Write-Host ""
  Write-Host "Wayward Anima Server" -ForegroundColor Cyan
  Write-Host "Game root : $GameRoot"

  if (-not $identity.Running) {
    Write-Host "Server    : STOPPED" -ForegroundColor Yellow
    Write-Host "ComfyUI   : $(if ($comfy) { 'ONLINE' } else { 'OFFLINE' }) ($comfyUrl)"
    return $identity
  }

  if (-not $identity.Owned) {
    Write-Host "Server    : PORT 8189 IS USED BY ANOTHER/UNKNOWN PROCESS" -ForegroundColor Red
    Write-Host "PID       : $($identity.Pid)"
    if ($identity.ConfigPath) {
      Write-Host "Config    : $($identity.ConfigPath)"
    }
    elseif ($identity.Error) {
      Write-Host "Probe     : $($identity.Error)"
    }
    Write-Host "ComfyUI   : $(if ($comfy) { 'ONLINE' } else { 'OFFLINE' }) ($comfyUrl)"
    return $identity
  }

  Write-Host "Server    : RUNNING" -ForegroundColor Green
  Write-Host "PID       : $($identity.Pid)"
  Write-Host "Config    : $($identity.ConfigPath)"
  Write-Host "ComfyUI   : $(if ($comfy) { 'ONLINE' } else { 'OFFLINE' }) ($comfyUrl)"

  $control = Get-ControlStatus
  if ($control) {
    $batch = $control.batch
    $active = @($control.activeJobs).Count
    Write-Host "Batch     : running=$($batch.running) paused=$($batch.paused) progress=$($batch.done)/$($batch.total)"
    Write-Host "Current   : $(if ($batch.currentKey) { $batch.currentKey } else { '-' })"
    Write-Host "AI jobs   : $active"
  }
  return $identity
}

function Start-Backend {
  $identity = Get-BackendIdentity
  if ($identity.Running) {
    if ($identity.Owned) {
      Write-Host "Server is already running (PID $($identity.Pid))." -ForegroundColor Green
      return
    }
    throw "Port 8189 is already used by another/unknown process (PID $($identity.Pid))."
  }

  if (-not (Test-Path $backendExe) -and -not (Test-Path $backendCli)) {
    throw "wayward-imagegen backend not found: $backendRoot"
  }

  $stateDir = Get-StateDir
  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
  $stdoutLog = Join-Path $stateDir "server-manager.out.log"
  $stderrLog = Join-Path $stateDir "server-manager.err.log"

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
      throw "Bun was not found in PATH. Use the Portable package or install Bun."
    }
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
    Start-Sleep -Milliseconds 350
    $current = Get-BackendIdentity
    if ($current.Running -and $current.Owned) {
      Write-Host "Server started (PID $($current.Pid))." -ForegroundColor Green
      return
    }
    if ($current.Running -and -not $current.Owned) {
      throw "Port 8189 was taken by another/unknown process while starting."
    }
  } while ((Get-Date) -lt $deadline)

  throw "Server did not become ready. Check: $stderrLog"
}

function Stop-Backend {
  $identity = Get-BackendIdentity
  if (-not $identity.Running) {
    Write-Host "Server is already stopped." -ForegroundColor Yellow
    return
  }
  if (-not $identity.Owned) {
    throw "Refusing to stop PID $($identity.Pid): port 8189 does not belong to this Wayward installation."
  }

  $control = Get-ControlStatus
  if ($control) {
    $active = @($control.activeJobs).Count
    if ($active -gt 0 -or [bool]$control.batch.running) {
      Write-Host "Active AI work detected. Graceful shutdown will pause the batch and cancel backend-owned ComfyUI work." -ForegroundColor Yellow
    }
  }

  Invoke-RestMethod `
    -Uri ($backendBase + "/api/control/shutdown") `
    -Method Post `
    -TimeoutSec 8 | Out-Null

  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 300
    if (-not (Get-PortOwner)) {
      Write-Host "Server stopped." -ForegroundColor Green
      return
    }
  } while ((Get-Date) -lt $deadline)

  throw "Server did not stop within 20 seconds."
}

function Open-Setup {
  Start-Backend
  Start-Process ($backendBase + "/setup.html")
}

function Start-Game {
  if (-not (Test-Path $launcherCmd)) {
    throw "Wayward-Anima.cmd not found: $launcherCmd"
  }
  Start-Process $launcherCmd
}

function Invoke-Action([string]$Name) {
  switch ($Name) {
    "Status" { $null = Show-Status }
    "Start" { Start-Backend; $null = Show-Status }
    "Stop" { Stop-Backend; $null = Show-Status }
    "Restart" { Stop-Backend; Start-Backend; $null = Show-Status }
    "Setup" { Open-Setup; $null = Show-Status }
    "Game" { Start-Game }
    default { throw "Unknown action: $Name" }
  }
}

function Show-Menu {
  while ($true) {
    Clear-Host
    $null = Show-Status
    Write-Host ""
    Write-Host "[1] Refresh status"
    Write-Host "[2] Start server only"
    Write-Host "[3] Stop server"
    Write-Host "[4] Restart server"
    Write-Host "[5] Open setup page"
    Write-Host "[6] Start Wayward"
    Write-Host "[0] Exit"
    Write-Host ""
    $choice = Read-Host "Select"

    try {
      switch ($choice) {
        "1" { }
        "2" { Start-Backend }
        "3" { Stop-Backend }
        "4" { Stop-Backend; Start-Backend }
        "5" { Open-Setup }
        "6" { Start-Game }
        "0" { return }
        default { Write-Host "Unknown selection." -ForegroundColor Yellow }
      }
    }
    catch {
      Write-Host ""
      Write-Host $_.Exception.Message -ForegroundColor Red
    }

    if ($choice -ne "1") {
      Write-Host ""
      Read-Host "Press Enter to continue" | Out-Null
    }
  }
}

if ($Action -eq "Menu") {
  Show-Menu
}
else {
  Invoke-Action $Action
}
