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

$statusItem.Text = "상태: 확인 중"
$startItem.Text = "서버 시작"
$stopItem.Text = "서버 종료"
$restartItem.Text = "서버 재시작"
$setupItem.Text = "설정 화면 열기"
$gameItem.Text = "Wayward 실행"
$exitItem.Text = "트레이 종료"

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
$notify.Text = "Wayward Anima: 확인 중"
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
      Label = "중지됨"
      Detail = "AI backend가 실행 중이 아닙니다."
      Owned = $false
      Control = $null
    }
  }

  try {
    $control = Invoke-RestMethod -Uri ($backendBase + "/api/control/status") -TimeoutSec 2
    $reported = [System.IO.Path]::GetFullPath([string]$control.instance.configPath)
    $owned = [string]::Equals($reported, $configPath, [System.StringComparison]::OrdinalIgnoreCase)
    if (-not $owned) {
      return [PSCustomObject]@{
        Kind = "foreign"
        Label = "다른 설치가 8189 사용 중"
        Detail = "PID $($port.OwningProcess)`nConfig: $reported`n이 트레이에서는 해당 서버를 종료하지 않습니다."
        Owned = $false
        Control = $control
      }
    }

    $batch = $control.batch
    $idle = $control.idleShutdown
    $idleLine = "자동 종료: 꺼짐"
    if ($idle.enabled) {
      if ($idle.blockedBy.Count -gt 0) {
        $idleLine = "자동 종료: 대기 (" + ($idle.blockedBy -join ", ") + ")"
      }
      elseif ($idle.remainingSeconds -gt 0) {
        $idleLine = "자동 종료: 약 $($idle.remainingSeconds)초 후"
      }
      else {
        $idleLine = "자동 종료: 조건 충족"
      }
    }
    $last = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$control.lastGameRequestAt).LocalDateTime
    $detail = @(
      "상태: $($control.state)",
      "PID: $($control.instance.pid)",
      "마지막 게임 요청: $($last.ToString('yyyy-MM-dd HH:mm:ss'))",
      "Batch: $($batch.done)/$($batch.total) · running=$($batch.running) · paused=$($batch.paused)",
      "AI jobs: $(@($control.activeJobs).Count)",
      $idleLine
    ) -join "`n"
    return [PSCustomObject]@{
      Kind = [string]$control.state
      Label = switch ([string]$control.state) {
        "generating" { "생성 중" }
        "paused" { "일시정지" }
        default { "실행 중" }
      }
      Detail = $detail
      Owned = $true
      Control = $control
    }
  }
  catch {
    return [PSCustomObject]@{
      Kind = "foreign"
      Label = "8189 응답 확인 실패"
      Detail = "PID $($port.OwningProcess)`n$($_.Exception.Message)`n소유권을 확인할 수 없어 종료하지 않습니다."
      Owned = $false
      Control = $null
    }
  }
}

function Update-Tray {
  $s = Get-Status
  $script:lastStatus = $s
  $statusItem.Text = "상태: " + $s.Label
  $notify.Text = ("Wayward Anima: " + $s.Label)
  if ($notify.Text.Length -gt 63) { $notify.Text = $notify.Text.Substring(0, 63) }

  switch ($s.Kind) {
    "generating" { $notify.Icon = [System.Drawing.SystemIcons]::Information }
    "paused" { $notify.Icon = [System.Drawing.SystemIcons]::Warning }
    "running" { $notify.Icon = [System.Drawing.SystemIcons]::Shield }
    "foreign" { $notify.Icon = [System.Drawing.SystemIcons]::Error }
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
      "Wayward-Anima-Server.ps1을 찾을 수 없습니다.`n$manager",
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
      "Wayward Anima - $Action 실패",
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
    "Wayward Anima 서버 상태",
    "OK",
    "Information"
  ) | Out-Null
})
$notify.add_DoubleClick({
  Update-Tray
  [System.Windows.Forms.MessageBox]::Show(
    $script:lastStatus.Detail,
    "Wayward Anima 서버 상태",
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
