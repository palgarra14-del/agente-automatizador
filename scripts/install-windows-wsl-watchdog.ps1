param(
  [ValidatePattern('^[A-Za-z0-9._-]{1,64}$')]
  [string]$Distro = 'Ubuntu',
  [ValidateRange(2,60)]
  [int]$IntervalMinutes = 5
)

$ErrorActionPreference = 'Stop'
$taskName = 'Engineering-Orchestrator-WSL-Watchdog'
$stateDir = Join-Path $env:LOCALAPPDATA 'EngineeringOrchestrator'
$source = Join-Path $PSScriptRoot 'windows-wsl-watchdog.ps1'
$destination = Join-Path $stateDir 'windows-wsl-watchdog.ps1'

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
Copy-Item -LiteralPath $source -Destination $destination -Force

$taskCommand = 'powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $destination + '" -Distro "' + $Distro + '"'
& schtasks.exe /Create /TN $taskName /TR $taskCommand /SC MINUTE /MO $IntervalMinutes /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'wsl_watchdog_task_install_failed' }

Write-Output "Installed $taskName every $IntervalMinutes minute(s)."
Write-Output "Watchdog: $destination"
Write-Output "Log: $(Join-Path $stateDir 'wsl-watchdog.log')"
