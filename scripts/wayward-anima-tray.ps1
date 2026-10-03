param(
  [string]$GameRoot = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($GameRoot)) {
  $GameRoot = $PSScriptRoot
}
$GameRoot = [System.IO.Path]::GetFullPath($GameRoot)

$backendRoot = Join-Path $GameRoot "wayward-imagegen"
$configPath = [System.IO.Path]::GetFullPath((Join-Path $backendRoot "wayward-imagegen.config.json"))
$manager = Join-Path $GameRoot "Wayward-Anima-Server.ps1"
$backendBase = "http://127.0.0.1:8189"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$sha = [System.Security.Cryptography.SHA256]::Create()
try {
  $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($GameRoot))).Replace("-", "").Substring(0, 20)
}
finally {
  $sha.Dispose()
}
$created = $false
$mutex = New-Object System.Threading.Mutex($true, ("Local\WaywardAnimaTray-" + $hash), [ref]$created)
if (-not $created) {
  $mutex.Dispose()
  exit 0
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem
$startItem = New-Object System.Windows.Forms.ToolStripMenuItem
$stopItem = New-Object System.Windows.Forms.ToolStripMenuItem
$restartItem = New-Object System.Windows.Forms.ToolStripMenuItem
$setupItem = New-Object System.Windows.Forms.ToolStripMenuItem
$gameItem = New-Object System.Windows.Forms.ToolStripMenuItem
$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$timer = New-Object System.Windows.Forms.Timer

$statusItem.Text = "Status: checking"
$startItem.Text = "Start server"
$stopItem.Text = "Stop server"
$restartItem.Text = "Restart server"
$setupItem.Text = "Open setup"
$gameItem.Text = "Start Wayward"
$exitItem.Text = "Exit tray"

$null = $menu.Items.Add($statusItem)
$null = $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$null = $menu.Items.Add($startItem)
$null = $menu.Items.Add($stopItem)
$null = $menu.Items.Add($restartItem)
$null = $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$null = $menu.Items.Add($setupItem)
$null = $menu.Items.Add($gameItem)
$null = $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$null = $menu.Items.Add($exitItem)

$notify.ContextMenuStrip = $menu
$notify.Icon = [System.Drawing.SystemIcons]::Application
$notify.Text = "Wayward Anima: checking"
$notify.Visible = $true

$script:lastStatus = $null
$script:exiting = $false

function Get-PortOwner {
  return Get-NetTCPConnection -LocalPort 8189 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

function Get-Status {
  $port = Get-PortOwner
  if (-not $port) {
    return [PSCustomObject]@{
      Kind = "stopped"
      Label = "stopped"
      Detail = "AI backend is not running."
      Owned = $false
      Control = $null
    }
  }

  $control = $null
  $reported = $null
  $legacy = $false
  $probeError = $null

  try {
    $control = Invoke-RestMethod -Uri ($backendBase + "/api/control/status") -TimeoutSec 2
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
      $setup = Invoke-RestMethod -Uri ($backendBase + "/api/setup/settings") -TimeoutSec 2
      if (-not [string]::IsNullOrWhiteSpace([string]$setup.configPath)) {
        $reported = [System.IO.Path]::GetFullPath([string]$setup.configPath)
      }
    }
    catch {
      if (-not $probeError) { $probeError = $_.Exception.Message }
    }
  }

  if (-not $reported) {
    return [PSCustomObject]@{
      Kind = "foreign"
      Label = "port 8189 probe failed"
      Detail = "PID $($port.OwningProcess)`n$probeError`nOwnership could not be verified, so this tray will not stop it."
      Owned = $false
      Control = $control
    }
  }

  $owned = [string]::Equals($reported, $configPath, [System.StringComparison]::OrdinalIgnoreCase)
  if (-not $owned) {
    return [PSCustomObject]@{
      Kind = "foreign"
      Label = "port 8189 belongs to another install"
      Detail = "PID $($port.OwningProcess)`nConfig: $reported`nThis tray will not stop that server."
      Owned = $false
      Control = $control
    }
  }

  if ($legacy) {
    $active = if ($control) { @($control.activeJobs).Count } else { 0 }
    $batchRunning = if ($control -and $control.batch) { [bool]$control.batch.running } else { $false }
    return [PSCustomObject]@{
      Kind = "legacy"
      Label = "backend restart required"
      Detail = "PID $($port.OwningProcess)`nConfig: $reported`nOlder backend detected.`nActive jobs: $active / batch running: $batchRunning`nUse Restart server to load the current backend."
      Owned = $true
      Control = $control
    }
  }

  $batch = $control.batch
  $idle = $control.idleShutdown
  $idleLine = "Auto shutdown: OFF"
  if ($idle.enabled) {
    if ($idle.blockedBy.Count -gt 0) {
      $idleLine = "Auto shutdown: waiting (" + ($idle.blockedBy -join ", ") + ")"
    }
    elseif ($idle.remainingSeconds -gt 0) {
      $idleLine = "Auto shutdown: about $($idle.remainingSeconds)s remaining"
    }
    else {
      $idleLine = "Auto shutdown: eligible"
    }
  }
  $last = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$control.lastGameRequestAt).LocalDateTime
  $detail = @(
    "State: $($control.state)",
    "PID: $($control.instance.pid)",
    "Last game request: $($last.ToString('yyyy-MM-dd HH:mm:ss'))",
    "Batch: $($batch.done)/$($batch.total) / running=$($batch.running) / paused=$($batch.paused)",
    "AI jobs: $(@($control.activeJobs).Count)",
    $idleLine
  ) -join "`n"
  return [PSCustomObject]@{
    Kind = [string]$control.state
    Label = switch ([string]$control.state) {
      "generating" { "generating" }
      "paused" { "paused" }
      default { "running" }
    }
    Detail = $detail
    Owned = $true
    Control = $control
  }
}

function Update-Tray {
  $s = Get-Status
  $script:lastStatus = $s
  $statusItem.Text = "Status: " + $s.Label
  $notify.Text = ("Wayward Anima: " + $s.Label)
  if ($notify.Text.Length -gt 63) { $notify.Text = $notify.Text.Substring(0, 63) }

  switch ($s.Kind) {
    "generating" { $notify.Icon = [System.Drawing.SystemIcons]::Information }
    "paused" { $notify.Icon = [System.Drawing.SystemIcons]::Warning }
    "running" { $notify.Icon = [System.Drawing.SystemIcons]::Shield }
    "foreign" { $notify.Icon = [System.Drawing.SystemIcons]::Error }
    "legacy" { $notify.Icon = [System.Drawing.SystemIcons]::Warning }
    default { $notify.Icon = [System.Drawing.SystemIcons]::Application }
  }

  $startItem.Enabled = ($s.Kind -eq "stopped")
  $stopItem.Enabled = $s.Owned
  $restartItem.Enabled = $s.Owned
  $setupItem.Enabled = ($s.Kind -eq "stopped" -or $s.Owned)
}

function Invoke-ManagerAction([string]$Action) {
  if (-not (Test-Path $manager)) {
    [System.Windows.Forms.MessageBox]::Show(
      "Wayward-Anima-Server.ps1 was not found.`n$manager",
      "Wayward Anima",
      "OK",
      "Error"
    ) | Out-Null
    return
  }

  $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $manager -Action $Action -GameRoot $GameRoot 2>&1
  if ($LASTEXITCODE -ne 0) {
    [System.Windows.Forms.MessageBox]::Show(
      (($output | Out-String).Trim()),
      "Wayward Anima - $Action failed",
      "OK",
      "Error"
    ) | Out-Null
  }
  Update-Tray
}

$statusItem.add_Click({
  Update-Tray
  [System.Windows.Forms.MessageBox]::Show(
    $script:lastStatus.Detail,
    "Wayward Anima server status",
    "OK",
    "Information"
  ) | Out-Null
})
$notify.add_DoubleClick({
  Update-Tray
  [System.Windows.Forms.MessageBox]::Show(
    $script:lastStatus.Detail,
    "Wayward Anima server status",
    "OK",
    "Information"
  ) | Out-Null
})
$startItem.add_Click({ Invoke-ManagerAction "Start" })
$stopItem.add_Click({ Invoke-ManagerAction "Stop" })
$restartItem.add_Click({ Invoke-ManagerAction "Restart" })
$setupItem.add_Click({ Invoke-ManagerAction "Setup" })
$gameItem.add_Click({ Invoke-ManagerAction "Game" })
$exitItem.add_Click({
  $script:exiting = $true
  [System.Windows.Forms.Application]::ExitThread()
})

$timer.Interval = 2500
$timer.add_Tick({ Update-Tray })
$timer.Start()

try {
  Update-Tray
  [System.Windows.Forms.Application]::Run()
}
finally {
  $timer.Stop()
  $timer.Dispose()
  $notify.Visible = $false
  $notify.Dispose()
  $menu.Dispose()
  try { $mutex.ReleaseMutex() } catch { }
  $mutex.Dispose()
}
