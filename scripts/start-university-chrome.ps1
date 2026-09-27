param(
  [Parameter(Mandatory=$true)]
  [string]$StartUrl,
  [ValidateRange(1024,65535)]
  [int]$Port = 9223,
  [string]$ProfilePath = "$env:LOCALAPPDATA\AgentUniversityChrome"
)

$ErrorActionPreference = "Stop"

try {
  $uri = [Uri]$StartUrl
} catch {
  throw "University start URL is invalid."
}

if ($uri.Scheme -ne "https" -or -not [string]::IsNullOrEmpty($uri.UserInfo)) {
  throw "University start URL must be credential-free HTTPS."
}

$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) {
  throw "Google Chrome was not found at the governed path."
}

New-Item -ItemType Directory -Force -Path $ProfilePath | Out-Null

$arguments = @(
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=$Port",
  "--user-data-dir=$ProfilePath",
  "--no-first-run",
  "--no-default-browser-check",
  $StartUrl
)

$process = Start-Process -FilePath $chrome -ArgumentList $arguments -PassThru

[PSCustomObject]@{
  pid = $process.Id
  origin = $uri.GetLeftPart([System.UriPartial]::Authority)
  cdp = "http://127.0.0.1:$Port"
  profile = $ProfilePath
} | ConvertTo-Json -Compress
