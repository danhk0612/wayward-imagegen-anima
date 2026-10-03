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
# a test install from accidentally stopping a live production session.
$listener = Get-NetTCPConnection -LocalPort 8189 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  throw "Port 8189 is already in use by PID $($listener.OwningProcess). Stop the current Wayward image backend before starting the test install."
}

$testDist = Join-Path $RepoRoot 'dist\test-install'
if (Test-Path $testDist) { Remove-Item $testDist -Recurse -Force }

Write-Host '== Build current Portable package ==' -ForegroundColor Cyan
& (Join-Path $PSScriptRoot 'build-portable-release.ps1') -OutputDir $testDist
if ($LASTEXITCODE -ne 0) { throw 'Portable package build failed.' }

$stage = Get-ChildItem $testDist -Directory -Filter 'Wayward-Anima-ImageGen-Portable-*' | Select-Object -First 1
if (-not $stage) { throw 'Portable staging directory was not created.' }

$targetBackend = Join-Path $GameRoot 'wayward-imagegen'
$targetPs1 = Join-Path $GameRoot 'Wayward-Anima.ps1'
$targetCmd = Join-Path $GameRoot 'Wayward-Anima.cmd'

if ($FreshPlugin) {
  Write-Host '== Remove only the previous test plugin files ==' -ForegroundColor Cyan
  foreach ($target in @($targetBackend, $targetPs1, $targetCmd)) {
    if (Test-Path $target) { Remove-Item $target -Recurse -Force }
  }
}
elseif ((Test-Path $targetBackend) -or (Test-Path $targetPs1) -or (Test-Path $targetCmd)) {
  throw 'A Wayward-Anima installation already exists in this game root. Use -FreshPlugin only for a disposable/test folder.'
}

Write-Host '== Install Portable package into Wayward root ==' -ForegroundColor Cyan
Copy-Item (Join-Path $stage.FullName 'wayward-imagegen') $targetBackend -Recurse -Force
Copy-Item (Join-Path $stage.FullName 'Wayward-Anima.ps1') $targetPs1 -Force
Copy-Item (Join-Path $stage.FullName 'Wayward-Anima.cmd') $targetCmd -Force
if (Test-Path (Join-Path $stage.FullName 'README.txt')) {
  Copy-Item (Join-Path $stage.FullName 'README.txt') (Join-Path $GameRoot 'Wayward-Anima-README.txt') -Force
}

if (Test-Path (Join-Path $targetBackend 'wayward-imagegen.config.json')) {
  throw 'Fresh Portable install unexpectedly contains a production config.'
}
if (Test-Path (Join-Path $targetBackend 'images')) {
  throw 'Fresh Portable install unexpectedly contains generated images.'
}

Write-Host ''
Write-Host 'Portable first-run test install is ready.' -ForegroundColor Green
Write-Host "Game root : $GameRoot"
Write-Host "Launcher  : $targetCmd"
Write-Host 'Expected first run: setup UI -> save profile -> backend restart -> Wayward opens.'

if ($Launch) {
  Write-Host 'Launching test installer...' -ForegroundColor Cyan
  Start-Process $targetCmd
}
