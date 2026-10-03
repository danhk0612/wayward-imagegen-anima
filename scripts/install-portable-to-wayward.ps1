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

if (-not (Test-Path $indexHtml)) {
  throw "Wayward index.html not found: $indexHtml"
}

# Do not silently take over the fixed Wayward image-server port. This prevents
# a test install/update from accidentally stopping a live production session.
$listener = Get-NetTCPConnection -LocalPort 8189 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  throw "Port 8189 is already in use by PID $($listener.OwningProcess). Stop the current Wayward image backend before installing/updating."
}

function Get-RuntimeSnapshot([string]$BackendRoot) {
  $configPath = Join-Path $BackendRoot 'wayward-imagegen.config.json'
  $imagesRoot = Join-Path $BackendRoot 'images'
  $configHash = $null
  if (Test-Path $configPath) {
    $configHash = (Get-FileHash $configPath -Algorithm SHA256).Hash
  }

  $files = @()
  if (Test-Path $imagesRoot) {
    $files = @(Get-ChildItem $imagesRoot -File -Recurse -ErrorAction SilentlyContinue)
  }
  [long]$bytes = 0
  foreach ($file in $files) { $bytes += [long]$file.Length }

  return [PSCustomObject]@{
    ConfigHash = $configHash
    ImageCount = $files.Count
    ImageBytes = $bytes
  }
}

function Assert-RuntimePreserved($Before, $After) {
  if ($Before.ConfigHash -ne $After.ConfigHash) {
    throw 'Safe Portable update changed wayward-imagegen.config.json.'
  }
  if ($Before.ImageCount -ne $After.ImageCount -or $Before.ImageBytes -ne $After.ImageBytes) {
    throw "Safe Portable update changed generated images: $($Before.ImageCount)/$($Before.ImageBytes) -> $($After.ImageCount)/$($After.ImageBytes)"
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
$targetBackend = Join-Path $GameRoot 'wayward-imagegen'
$targetPs1 = Join-Path $GameRoot 'Wayward-Anima.ps1'
$targetCmd = Join-Path $GameRoot 'Wayward-Anima.cmd'
$existing = (Test-Path $targetBackend) -or (Test-Path $targetPs1) -or (Test-Path $targetCmd)

if ($FreshPlugin) {
  Write-Host '== Fresh plugin install (destructive to plugin runtime data) ==' -ForegroundColor Yellow
  foreach ($target in @($targetBackend, $targetPs1, $targetCmd, (Join-Path $GameRoot 'Wayward-Anima-README.txt'))) {
    if (Test-Path $target) { Remove-Item $target -Recurse -Force }
  }
  $existing = $false
}

if (-not $existing) {
  Write-Host '== Install Portable package into Wayward root ==' -ForegroundColor Cyan
  Copy-Item $sourceBackend $targetBackend -Recurse -Force
}
else {
  Write-Host '== Safe Portable update: preserve config/images, replace runtime ==' -ForegroundColor Cyan
  $before = Get-RuntimeSnapshot $targetBackend

  New-Item -ItemType Directory -Path $targetBackend -Force | Out-Null
  foreach ($entry in @(Get-ChildItem $targetBackend -Force -ErrorAction SilentlyContinue)) {
    if ($entry.Name -in @('images', 'wayward-imagegen.config.json')) { continue }
    Remove-Item $entry.FullName -Recurse -Force
  }

  foreach ($entry in @(Get-ChildItem $sourceBackend -Force)) {
    Copy-Item $entry.FullName (Join-Path $targetBackend $entry.Name) -Recurse -Force
  }

  $after = Get-RuntimeSnapshot $targetBackend
  Assert-RuntimePreserved $before $after
  Write-Host ("Preserved runtime data: {0} generated files / {1:N2} MB" -f $after.ImageCount, ($after.ImageBytes / 1MB))
}

Copy-Item (Join-Path $stage.FullName 'Wayward-Anima.ps1') $targetPs1 -Force
Copy-Item (Join-Path $stage.FullName 'Wayward-Anima.cmd') $targetCmd -Force
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
  Write-Host 'Existing config and generated images were preserved.'
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
