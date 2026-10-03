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

$runtimeScripts = Join-Path $backend "scripts"
New-Item -ItemType Directory -Path $runtimeScripts -Force | Out-Null
Copy-Item (Join-Path (Join-Path $RepoRoot "scripts") "smoke.ts") (Join-Path $runtimeScripts "smoke.ts") -Force

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

Copy-Item (Join-Path (Join-Path $RepoRoot "scripts") "wayward-ai-launcher.ps1") (Join-Path $stage "Wayward-Anima.ps1") -Force

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

사용 순서
1. 이 ZIP의 내용을 Wayward index.html이 있는 폴더에 풉니다.
2. ComfyUI를 실행합니다.
3. Wayward-Anima.cmd를 더블클릭합니다.
4. 최초 실행에서는 브라우저 설정 화면에서 Anima 모델/LoRA/캐릭터를 설정합니다.
5. 이후에는 ComfyUI -> Wayward-Anima.cmd 순서로 실행하면 됩니다.

Lite 버전은 Bun이 PATH에 설치되어 있어야 합니다.
ComfyUI, 모델, LoRA, Wayward, 생성 이미지는 포함하지 않습니다.
일반 업데이트는 기존 설정/생성 이미지/캐시를 삭제하지 않습니다.

자세한 내용: wayward-imagegen\DISTRIBUTION.md
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
