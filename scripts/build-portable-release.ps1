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
$name = "Wayward-Anima-ImageGen-Portable-v$version"
$stage = Join-Path $OutputDir $name
$zip = Join-Path $OutputDir ($name + ".zip")
$backend = Join-Path $stage "wayward-imagegen"
$exe = Join-Path $backend "wayward-imagegen.exe"

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
if (Test-Path $zip) { Remove-Item $zip -Force }
New-Item -ItemType Directory -Path $backend -Force | Out-Null

Write-Host "Compiling standalone backend..."
Push-Location $RepoRoot
try {
  & bun build "src/cli.ts" --compile --external sharp --outfile $exe
  if ($LASTEXITCODE -ne 0) { throw "Standalone backend compilation failed." }
}
finally {
  Pop-Location
}

if (-not (Test-Path $exe)) { throw "Compiled backend executable not found: $exe" }

Copy-Item (Join-Path $RepoRoot "ui") (Join-Path $backend "ui") -Recurse -Force

foreach ($file in @(
  "LICENSE",
  "NOTICE.md",
  "README.md",
  "ANIMA_SETUP.md",
  "DISTRIBUTION.md",
  "CHANGELOG.md",
  "wayward-imagegen.config.anima.example.json"
)) {
  $source = Join-Path $RepoRoot $file
  if (Test-Path $source) { Copy-Item $source (Join-Path $backend $file) -Force }
}

Copy-Item (Join-Path (Join-Path $RepoRoot "scripts") "wayward-ai-launcher.ps1") (Join-Path $stage "Wayward-Anima.ps1") -Force
Copy-Item (Join-Path (Join-Path $RepoRoot "scripts") "wayward-anima-server-manager.ps1") (Join-Path $stage "Wayward-Anima-Server.ps1") -Force

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

$serverCmd = @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Wayward-Anima-Server.ps1"
if errorlevel 1 pause
'@
[System.IO.File]::WriteAllText(
  (Join-Path $stage "Wayward-Anima-Server.cmd"),
  $serverCmd,
  [System.Text.Encoding]::ASCII
)

$readme = @'
Wayward Anima ImageGen - Portable

1. Extract this package into the folder that contains Wayward index.html.
2. Start ComfyUI.
3. Double-click Wayward-Anima.cmd.
4. On first run, configure the Anima model, LoRA and Wayward character in the browser setup page.
5. Later, normal startup is: ComfyUI -> Wayward-Anima.cmd.
6. Use Wayward-Anima-Server.cmd to check whether the hidden backend is still running, or to start/stop/restart it without opening the game.

Bun is not required for the Portable package.
ComfyUI, models, LoRAs, Wayward and generated images are not included.
Routine updates preserve existing config, generated images and cache.

The browser setup UI is localized and contains the detailed setup guidance.
See wayward-imagegen\DISTRIBUTION.md for technical details.
'@
[System.IO.File]::WriteAllText(
  (Join-Path $stage "README.txt"),
  $readme,
  (New-Object System.Text.UTF8Encoding($false))
)

$forbidden = @(
  ".git", "node_modules", "src", "scripts", "images", "images-quality-test", "AB-anima-models",
  "deployment-backup", "wayward-imagegen.config.json"
)
foreach ($item in $forbidden) {
  $matches = @(Get-ChildItem $stage -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $item })
  if ($matches.Count -gt 0) {
    throw "Portable release contains forbidden runtime/development item: $item"
  }
}

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal

$exeBytes = (Get-Item $exe).Length
$zipBytes = (Get-Item $zip).Length
Write-Host "Built: $zip"
Write-Host ("EXE  : {0:N2} MB" -f ($exeBytes / 1MB))
Write-Host ("ZIP  : {0:N2} MB" -f ($zipBytes / 1MB))
Write-Host "Bun/models/LoRAs/ComfyUI/Wayward/generated-image assets are not bundled."
