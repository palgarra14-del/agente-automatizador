param(
  [ValidatePattern('^[A-Za-z0-9._-]{1,64}$')]
  [string]$Distro = 'Ubuntu'
)

$ErrorActionPreference = 'Stop'
$stateDir = Join-Path $env:LOCALAPPDATA 'EngineeringOrchestrator'
$log = Join-Path $stateDir 'wsl-watchdog.log'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

function Invoke-BoundedWsl([string]$arguments, [int]$timeoutMs = 15000) {
  $wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
  $process = Start-Process -FilePath $wsl -ArgumentList $arguments -PassThru -WindowStyle Hidden
  if ($null -eq $process) { throw 'wsl_start_returned_null' }
  if (-not $process.WaitForExit($timeoutMs)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    return 124
  }
  return $process.ExitCode
}

$stamp = (Get-Date).ToString('s')
try {
  $probe = Invoke-BoundedWsl "-d $Distro --exec /bin/true" 12000
  if ($probe -ne 0) {
    Add-Content $log "$stamp probe_exit=$probe"
    exit 2
  }

  $command = 'systemctl --user start engineering-orchestrator-inbox.service actions-runner-callflow.service actions-runner-leadfinder.service actions-runner-self.service ollama-local.service engineering-orchestrator-cloud-heartbeat.timer'
  $escaped = $command.Replace('"','\"')
  $ensure = Invoke-BoundedWsl ('-d ' + $Distro + ' --exec /bin/bash -lc "' + $escaped + '"') 15000
  Add-Content $log "$stamp healthy ensure_exit=$ensure"
  exit $ensure
} catch {
  Add-Content $log "$stamp exception=$($_.Exception.Message)"
  exit 3
}
