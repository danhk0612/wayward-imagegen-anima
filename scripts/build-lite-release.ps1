param(
  [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $RepoRoot "dist"
}

$package = Get-Content (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json
$version = [string]$package.version
$name = "Wayward-Anima-ImageGen-Lite-v$version"
$stage = Join-Path $OutputDir $name
$zip = Join-Path $OutputDir ($name + ".zip")
$backend = Join-Path $stage "wayward-imagegen"

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
if (Test-Path $zip) { Remove-Item $zip -Force }
New-Item -ItemType Directory -Path $backend -Force | Out-Null

foreach ($dir in @("src", "ui")) {
  Copy-Item (Join-Path $RepoRoot $dir) (Join-Path $backend $dir) -Recurse -Force
}

foreach ($file in @(
  "package.json",
  "LICENSE",
  "NOTICE.md",
  "README.md",
  "ANIMA_SETUP.md",
  "DISTRIBUTION.md",
  "wayward-imagegen.config.anima.example.json"
)) {
  $source = Join-Path $RepoRoot $file
  if (Test-Path $source) { Copy-Item $source (Join-Path $backend $file) -Force }
}

Copy-Item (Join-Path $RepoRoot "scripts\wayward-ai-launcher.ps1") (Join-Path $stage "Wayward-Anima.ps1") -Force

$cmd = @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Wayward-Anima.ps1"
if errorlevel 1 pause
'@
[System.IO.File]::WriteAllText(
  (Join-Path $stage "Wayward-Anima.cmd"),
  $cmd,
  [System.Text.Encoding]::ASCII
)

$readme = @'
Wayward Anima ImageGen - Lite

1. Put this package next to Wayward index.html.
2. Start ComfyUI.
3. Double-click Wayward-Anima.cmd.
4. Complete the browser setup wizard on first run.

Required: Bun in PATH and an already-working ComfyUI installation.
Models, LoRAs, ComfyUI, Wayward and generated images are not included.

See wayward-imagegen\DISTRIBUTION.md for details.
'@
[System.IO.File]::WriteAllText(
  (Join-Path $stage "README.txt"),
  $readme,
  (New-Object System.Text.UTF8Encoding($false))
)

$forbidden = @(
  ".git", "node_modules", "images", "images-quality-test", "AB-anima-models",
  "deployment-backup", "wayward-imagegen.config.json"
)
foreach ($item in $forbidden) {
  $matches = @(Get-ChildItem $stage -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $item })
  if ($matches.Count -gt 0) {
    throw "Release contains forbidden runtime/development item: $item"
  }
}

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal

$bytes = (Get-Item $zip).Length
Write-Host "Built: $zip"
Write-Host ("Size : {0:N2} MB" -f ($bytes / 1MB))
Write-Host "The ZIP contains no model/LoRA/ComfyUI/Wayward/generated-image assets."
