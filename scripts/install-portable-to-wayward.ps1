param(
  [Parameter(Mandatory = $true)]
  [string]$GameRoot,
  [switch]$FreshPlugin,
  [switch]$Launch
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$GameRoot = (Resolve-Path $GameRoot).Path
$indexHtml = Join-Path $GameRoot 'index.html'
$targetBackend = Join-Path $GameRoot 'wayward-imagegen'
$targetPs1 = Join-Path $GameRoot 'Wayward-Anima.ps1'
$targetCmd = Join-Path $GameRoot 'Wayward-Anima.cmd'
$targetServerPs1 = Join-Path $GameRoot 'Wayward-Anima-Server.ps1'
$targetServerCmd = Join-Path $GameRoot 'Wayward-Anima-Server.cmd'

if (-not (Test-Path $indexHtml)) {
  throw "Wayward index.html not found: $indexHtml"
}

# If the backend currently using 8189 belongs to this exact Wayward root and is
# idle, shut it down cleanly for the update. Never stop a different install.
$listener = Get-NetTCPConnection -LocalPort 8189 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $sameTarget = $false
  try {
    $running = Invoke-RestMethod 'http://127.0.0.1:8189/api/setup/settings' -TimeoutSec 3
    $runningConfig = [System.IO.Path]::GetFullPath([string]$running.configPath)
    $targetConfig = [System.IO.Path]::GetFullPath((Join-Path $targetBackend 'wayward-imagegen.config.json'))
    $sameTarget = [string]::Equals($runningConfig, $targetConfig, [System.StringComparison]::OrdinalIgnoreCase)
  }
  catch {
    $sameTarget = $false
  }

  if (-not $sameTarget) {
    throw "Port 8189 is in use by another/unknown backend (PID $($listener.OwningProcess)). Stop that backend first; this installer will not touch a different Wayward environment."
  }

  try {
    $control = Invoke-RestMethod 'http://127.0.0.1:8189/api/control/status' -TimeoutSec 3
    $active = @($control.activeJobs).Count
    $batchRunning = [bool]$control.batch.running
    if ($active -gt 0 -or $batchRunning) {
      throw "The target backend is generating work (active jobs: $active, batch running: $batchRunning). Pause/wait for it before updating."
    }

    Write-Host '== Stop idle target backend for update ==' -ForegroundColor Cyan
    Invoke-RestMethod 'http://127.0.0.1:8189/api/control/shutdown' -Method Post -TimeoutSec 5 | Out-Null
    $deadline = (Get-Date).AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 300
      $stillListening = Get-NetTCPConnection -LocalPort 8189 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
      if (-not $stillListening) { break }
    } while ((Get-Date) -lt $deadline)
    if ($stillListening) { throw 'Target backend did not release port 8189 within 15 seconds.' }
  }
  catch {
    throw $_
  }
}

function Resolve-RuntimePath([string]$BackendRoot, [string]$Configured, [string]$Fallback) {
  $raw = if ([string]::IsNullOrWhiteSpace($Configured)) { $Fallback } else { $Configured }
  if ([System.IO.Path]::IsPathRooted($raw)) {
    return [System.IO.Path]::GetFullPath($raw)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $BackendRoot $raw))
}

function Get-TreeStats([string]$Root) {
  $files = @()
  if (Test-Path $Root) {
    $files = @(Get-ChildItem $Root -File -Recurse -ErrorAction SilentlyContinue)
  }
  [long]$bytes = 0
  foreach ($file in $files) { $bytes += [long]$file.Length }
  return [PSCustomObject]@{ Count = $files.Count; Bytes = $bytes }
}

function Get-RuntimeInfo([string]$BackendRoot) {
  $configPath = Join-Path $BackendRoot 'wayward-imagegen.config.json'
  $config = $null
  $configHash = $null
  if (Test-Path $configPath) {
    $configHash = (Get-FileHash $configPath -Algorithm SHA256).Hash
    try { $config = Get-Content $configPath -Raw | ConvertFrom-Json } catch { $config = $null }
  }

  $imagesSetting = if ($config -and $config.PSObject.Properties.Name -contains 'imagesDir') { [string]$config.imagesDir } else { 'images' }
  $imagesRoot = Resolve-RuntimePath $BackendRoot $imagesSetting 'images'

  $stateSetting = if ($config -and $config.PSObject.Properties.Name -contains 'stateDir') { [string]$config.stateDir } else { '' }
  $stateRoot = if ([string]::IsNullOrWhiteSpace($stateSetting)) {
    Join-Path $imagesRoot '.state'
  }
  else {
    Resolve-RuntimePath $BackendRoot $stateSetting (Join-Path $imagesSetting '.state')
  }

  return [PSCustomObject]@{
    ConfigPath = $configPath
    ConfigHash = $configHash
    ImagesRoot = [System.IO.Path]::GetFullPath($imagesRoot)
    StateRoot = [System.IO.Path]::GetFullPath($stateRoot)
    ImageStats = Get-TreeStats $imagesRoot
    StateStats = Get-TreeStats $stateRoot
  }
}

function Get-PreservedTopLevelNames([string]$BackendRoot, $RuntimeInfo) {
  $root = [System.IO.Path]::GetFullPath($BackendRoot).TrimEnd('\') + '\'
  $names = @('wayward-imagegen.config.json')

  foreach ($candidate in @($RuntimeInfo.ImagesRoot, $RuntimeInfo.StateRoot)) {
    $full = [System.IO.Path]::GetFullPath($candidate)
    if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    $relative = $full.Substring($root.Length)
    if ([string]::IsNullOrWhiteSpace($relative)) { continue }
    $top = $relative.Split([char]'\')[0]
    if ($top -and $names -notcontains $top) { $names += $top }
  }
  return $names
}

function Assert-RuntimePreserved($Before, $After) {
  if ($Before.ConfigHash -ne $After.ConfigHash) {
    throw 'Safe Portable update changed wayward-imagegen.config.json.'
  }
  if ($Before.ImageStats.Count -ne $After.ImageStats.Count -or $Before.ImageStats.Bytes -ne $After.ImageStats.Bytes) {
    throw "Safe Portable update changed generated images: $($Before.ImageStats.Count)/$($Before.ImageStats.Bytes) -> $($After.ImageStats.Count)/$($After.ImageStats.Bytes)"
  }
  if ($Before.StateStats.Count -ne $After.StateStats.Count -or $Before.StateStats.Bytes -ne $After.StateStats.Bytes) {
    throw "Safe Portable update changed runtime state: $($Before.StateStats.Count)/$($Before.StateStats.Bytes) -> $($After.StateStats.Count)/$($After.StateStats.Bytes)"
  }
}

$testDist = Join-Path $RepoRoot 'dist\test-install'
if (Test-Path $testDist) { Remove-Item $testDist -Recurse -Force }

Write-Host '== Build current Portable package ==' -ForegroundColor Cyan
& (Join-Path $PSScriptRoot 'build-portable-release.ps1') -OutputDir $testDist
if ($LASTEXITCODE -ne 0) { throw 'Portable package build failed.' }

$stage = Get-ChildItem $testDist -Directory -Filter 'Wayward-Anima-ImageGen-Portable-*' | Select-Object -First 1
if (-not $stage) { throw 'Portable staging directory was not created.' }

$sourceBackend = Join-Path $stage.FullName 'wayward-imagegen'
$existing = (Test-Path $targetBackend) -or (Test-Path $targetPs1) -or (Test-Path $targetCmd) -or (Test-Path $targetServerPs1) -or (Test-Path $targetServerCmd)

if ($FreshPlugin) {
  Write-Host '== Fresh plugin install (destructive to plugin runtime data) ==' -ForegroundColor Yellow
  foreach ($target in @($targetBackend, $targetPs1, $targetCmd, $targetServerPs1, $targetServerCmd, (Join-Path $GameRoot 'Wayward-Anima-README.txt'))) {
    if (Test-Path $target) { Remove-Item $target -Recurse -Force }
  }
  $existing = $false
}

if (-not $existing) {
  Write-Host '== Install Portable package into Wayward root ==' -ForegroundColor Cyan
  Copy-Item $sourceBackend $targetBackend -Recurse -Force
}
else {
  Write-Host '== Safe Portable update: preserve config/runtime data, replace runtime code ==' -ForegroundColor Cyan
  $before = Get-RuntimeInfo $targetBackend
  $preserveNames = Get-PreservedTopLevelNames $targetBackend $before

  New-Item -ItemType Directory -Path $targetBackend -Force | Out-Null
  foreach ($entry in @(Get-ChildItem $targetBackend -Force -ErrorAction SilentlyContinue)) {
    if ($preserveNames -contains $entry.Name) { continue }
    Remove-Item $entry.FullName -Recurse -Force
  }

  foreach ($entry in @(Get-ChildItem $sourceBackend -Force)) {
    Copy-Item $entry.FullName (Join-Path $targetBackend $entry.Name) -Recurse -Force
  }

  $after = Get-RuntimeInfo $targetBackend
  Assert-RuntimePreserved $before $after
  Write-Host ("Preserved generated images: {0} files / {1:N2} MB" -f $after.ImageStats.Count, ($after.ImageStats.Bytes / 1MB))
  Write-Host ("Preserved runtime state   : {0} files / {1:N2} MB" -f $after.StateStats.Count, ($after.StateStats.Bytes / 1MB))
  Write-Host "Preserved configured paths: images=$($after.ImagesRoot) state=$($after.StateRoot)"
}

Copy-Item (Join-Path $stage.FullName 'Wayward-Anima.ps1') $targetPs1 -Force
Copy-Item (Join-Path $stage.FullName 'Wayward-Anima.cmd') $targetCmd -Force
Copy-Item (Join-Path $stage.FullName 'Wayward-Anima-Server.ps1') $targetServerPs1 -Force
Copy-Item (Join-Path $stage.FullName 'Wayward-Anima-Server.cmd') $targetServerCmd -Force
if (Test-Path (Join-Path $stage.FullName 'README.txt')) {
  Copy-Item (Join-Path $stage.FullName 'README.txt') (Join-Path $GameRoot 'Wayward-Anima-README.txt') -Force
}

if (-not $existing -and -not $FreshPlugin) {
  if (Test-Path (Join-Path $targetBackend 'wayward-imagegen.config.json')) {
    throw 'Fresh Portable install unexpectedly contains a production config.'
  }
  if (Test-Path (Join-Path $targetBackend 'images')) {
    throw 'Fresh Portable install unexpectedly contains generated images.'
  }
}

Write-Host ''
if ($existing -and -not $FreshPlugin) {
  Write-Host 'Portable update is ready.' -ForegroundColor Green
  Write-Host 'Existing config, configured image library and state were preserved.'
}
else {
  Write-Host 'Portable first-run install is ready.' -ForegroundColor Green
}
Write-Host "Game root : $GameRoot"
Write-Host "Launcher  : $targetCmd"
if (-not $existing) {
  Write-Host 'Expected first run: setup UI -> save profile -> backend restart -> Wayward opens.'
}

if ($Launch) {
  Write-Host 'Launching Wayward Anima...' -ForegroundColor Cyan
  Start-Process $targetCmd
}
