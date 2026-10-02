param(
  [string]$GameRoot = "E:\GAME\Wayward",
  [string]$Character = "elena",
  [switch]$KeepDevelopmentTestArtifacts
)

$ErrorActionPreference = "Stop"

$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$TargetRoot = Join-Path $GameRoot "wayward-imagegen"

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText(
    $Path,
    $Text,
    (New-Object System.Text.UTF8Encoding($false))
  )
}

function Remove-CharacterCacheEntries([string]$CachePath, [string]$CharacterName) {
  if (-not (Test-Path $CachePath)) {
    Write-Host "No cache index to prune: $CachePath"
    return
  }

  $cache = Get-Content $CachePath -Raw | ConvertFrom-Json
  if (-not $cache.entries) {
    Write-Host "Cache index has no entries."
    return
  }

  $kept = [ordered]@{}
  $removed = 0
  $prefix = ($CharacterName.ToLowerInvariant() + "__")

  foreach ($property in $cache.entries.PSObject.Properties) {
    $talentName = [string]$property.Value.talentName
    if ($talentName.ToLowerInvariant().StartsWith($prefix)) {
      $removed++
    }
    else {
      $kept[$property.Name] = $property.Value
    }
  }

  $cache.entries = [PSCustomObject]$kept
  Write-Utf8NoBom $CachePath ($cache | ConvertTo-Json -Depth 50)
  Write-Host "Removed $removed cache entries for $CharacterName; kept $($kept.Count)."
}

Write-Step "Preflight"

if (-not (Test-Path (Join-Path $SourceRoot "src\cli.ts"))) {
  throw "Source repository does not look valid: $SourceRoot"
}
if (-not (Test-Path $TargetRoot)) {
  throw "Wayward backend folder not found: $TargetRoot"
}

$listen = Get-NetTCPConnection -LocalPort 8189 -State Listen -ErrorAction SilentlyContinue
if ($listen) {
  throw "Port 8189 is still in use. Stop the running wayward-imagegen server first, then rerun this script."
}

Write-Host "Source : $SourceRoot"
Write-Host "Target : $TargetRoot"

Write-Step "Back up the current production config"

$targetConfig = Join-Path $TargetRoot "wayward-imagegen.config.json"
$backupDir = Join-Path $SourceRoot "deployment-backup"
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

if (Test-Path $targetConfig) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupConfig = Join-Path $backupDir "wayward-imagegen.config.$stamp.json"
  Copy-Item $targetConfig $backupConfig -Force
  Write-Host "Config backup: $backupConfig"
}
else {
  Write-Host "No existing production config."
}

Write-Step "Replace production backend code with the tested Anima build"

foreach ($dir in @("src", "ui", "scripts")) {
  $target = Join-Path $TargetRoot $dir
  if (Test-Path $target) {
    Remove-Item $target -Recurse -Force
  }
  Copy-Item (Join-Path $SourceRoot $dir) $target -Recurse -Force
}

foreach ($file in @(
  "package.json",
  "README.md",
  "ANIMA_SETUP.md",
  "LICENSE",
  "wayward-imagegen.config.example.json",
  "wayward-imagegen.config.anima.example.json"
)) {
  $source = Join-Path $SourceRoot $file
  if (Test-Path $source) {
    Copy-Item $source (Join-Path $TargetRoot $file) -Force
  }
}

Write-Step "Install the production Anima configuration"

$sourceConfig = Join-Path $SourceRoot "wayward-imagegen.config.json"
if (-not (Test-Path $sourceConfig)) {
  throw "Tested Anima config not found: $sourceConfig"
}

$config = Get-Content $sourceConfig -Raw | ConvertFrom-Json
$config.imagesDir = "images"
$config.steps = 30
$config.cfg = 4.5
$config.sampler = "er_sde"
$config.scheduler = "simple"

if ($config.complexScenePolicy) {
  $config.complexScenePolicy.enabled = $false
}

if ($config.PSObject.Properties.Name -contains "stateDir") {
  if ([string]$config.stateDir -like "*images-quality-test*") {
    $config.stateDir = "images\.state"
  }
}

Write-Utf8NoBom $targetConfig ($config | ConvertTo-Json -Depth 50)

Write-Host "imagesDir : $($config.imagesDir)"
Write-Host "preset    : $($config.imagePreset)"
Write-Host "model     : $($config.animaModel)"
Write-Host "render    : $($config.steps) steps / CFG $($config.cfg) / $($config.sampler) / $($config.scheduler)"
if ($config.characterProfiles.$Character) {
  $loraText = @($config.characterProfiles.$Character.loras | ForEach-Object {
    "$($_.name):$($_.strengthModel)"
  }) -join ", "
  Write-Host "$Character LoRA: $loraText"
}

Write-Step "Reset only the production character art"

$imagesRoot = Join-Path $TargetRoot "images"
New-Item -ItemType Directory -Path $imagesRoot -Force | Out-Null

$characterDir = Join-Path $imagesRoot ("illustrious\characters\" + $Character)
if (Test-Path $characterDir) {
  Remove-Item $characterDir -Recurse -Force
  Write-Host "Deleted generated art: $characterDir"
}
else {
  Write-Host "No existing generated art folder for $Character."
}

Remove-CharacterCacheEntries (Join-Path $imagesRoot ".image-cache.json") $Character

$legacyCharacterDir = Join-Path $GameRoot ("images\illustrious\characters\" + $Character)
if (Test-Path $legacyCharacterDir) {
  Remove-Item $legacyCharacterDir -Recurse -Force
  Write-Host "Deleted legacy/shipped game-root art so Wayward will request fresh renders:"
  Write-Host "  $legacyCharacterDir"
}
else {
  Write-Host "No game-root legacy art folder for $Character."
}

$batchDir = Join-Path $imagesRoot ".state\batch"
if (Test-Path $batchDir) {
  Remove-Item $batchDir -Recurse -Force
  Write-Host "Cleared old batch state."
}

Write-Step "Remove known test-only artifacts from the production backend"

foreach ($name in @("images-quality-test", "AB-anima-models")) {
  $path = Join-Path $TargetRoot $name
  if (Test-Path $path) {
    Remove-Item $path -Recurse -Force
    Write-Host "Removed: $path"
  }
}

if (-not $KeepDevelopmentTestArtifacts) {
  Write-Step "Remove known generated test artifacts from the development repository"
  foreach ($name in @("images-quality-test", "AB-anima-models")) {
    $path = Join-Path $SourceRoot $name
    if (Test-Path $path) {
      Remove-Item $path -Recurse -Force
      Write-Host "Removed: $path"
    }
  }
}

Write-Step "Install one-click Wayward launcher"

$launcherSource = Join-Path $SourceRoot "scripts\wayward-ai-launcher.ps1"
$launcherPs1 = Join-Path $GameRoot "Wayward-AI.ps1"
$launcherCmd = Join-Path $GameRoot "Wayward-AI.cmd"

Copy-Item $launcherSource $launcherPs1 -Force

$launcherCmdText = @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Wayward-AI.ps1"
if errorlevel 1 pause
'@
[System.IO.File]::WriteAllText(
  $launcherCmd,
  $launcherCmdText,
  [System.Text.Encoding]::ASCII
)

Write-Host "Launcher installed:"
Write-Host "  $launcherCmd"

Write-Step "Production validation"

Push-Location $TargetRoot
try {
  & bun scripts\smoke.ts
  if ($LASTEXITCODE -ne 0) {
    throw "Smoke test failed."
  }

  & bun src\cli.ts doctor
  if ($LASTEXITCODE -ne 0) {
    throw "Doctor failed."
  }
}
finally {
  Pop-Location
}

Write-Step "Ready"

Write-Host "Production backend:"
Write-Host "  $TargetRoot"
Write-Host ""
Write-Host "New $Character images will be generated into:"
Write-Host "  $(Join-Path $imagesRoot ("illustrious\characters\" + $Character))"
Write-Host ""
Write-Host "The old $Character generated art/cache and game-root legacy art were removed; other cached characters were preserved."
Write-Host "Normal use:"
Write-Host "  1. Start ComfyUI."
Write-Host "  2. Double-click $(Join-Path $GameRoot "Wayward-AI.cmd")."
Write-Host "The launcher starts wayward-imagegen when needed and then opens Wayward."
