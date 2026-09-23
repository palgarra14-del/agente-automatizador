import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { runLocalCommand } from './service.js';

export const DESKTOP_BRIDGE_VERSION = 1;
const maxTextLength = 8_192;
const maxArgs = 32;
const maxWindows = 200;
const allowedActions = new Set([
  'system.info',
  'process.list',
  'window.list',
  'screen.capture',
  'url.open',
  'app.launch',
  'window.focus',
  'input.click',
  'input.keys'
]);
const interactiveActions = new Set(['url.open', 'app.launch', 'window.focus', 'input.click', 'input.keys']);

function boundedText(value, label, { max = maxTextLength, allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value) || value.length > max || value.includes('\0')) {
    throw new Error(`desktop_${label}_invalid`);
  }
  return value;
}

function positiveInteger(value, label, { min = 1, max = 2_147_483_647 } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`desktop_${label}_invalid`);
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`desktop_${label}_fields_invalid`);
  }
}

function normalizeArgs(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxArgs) throw new Error('desktop_args_invalid');
  return value.map((entry, index) => boundedText(entry, `args_${index}`, { max: 1_024, allowEmpty: true }));
}

function normalizeRequestShape(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('desktop_request_invalid');
  const action = boundedText(request.action, 'action', { max: 64 });
  if (!allowedActions.has(action)) throw new Error('desktop_action_not_supported');

  switch (action) {
    case 'system.info':
    case 'process.list':
    case 'window.list':
    case 'screen.capture':
      exactKeys(request, ['action'], 'request');
      return { action };
    case 'url.open': {
      exactKeys(request, ['action', 'url'], 'request');
      const url = boundedText(request.url, 'url', { max: 2_048 });
      let parsed;
      try { parsed = new URL(url); } catch { throw new Error('desktop_url_invalid'); }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('desktop_url_scheme_not_allowed');
      return { action, url: parsed.toString() };
    }
    case 'app.launch': {
      const keys = Object.keys(request).sort();
      if (!['action,executable', 'action,args,executable'].includes(keys.join(','))) throw new Error('desktop_request_fields_invalid');
      const executable = boundedText(request.executable, 'executable', { max: 1_024 });
      if (executable.includes(String.fromCharCode(13)) || executable.includes(String.fromCharCode(10))) throw new Error('desktop_executable_invalid');
      return { action, executable, args: normalizeArgs(request.args) };
    }
    case 'window.focus':
      exactKeys(request, ['action', 'processId'], 'request');
      return { action, processId: positiveInteger(request.processId, 'process_id') };
    case 'input.click':
      exactKeys(request, ['action', 'x', 'y'], 'request');
      return {
        action,
        x: positiveInteger(request.x, 'x', { min: 0, max: 65_535 }),
        y: positiveInteger(request.y, 'y', { min: 0, max: 65_535 })
      };
    case 'input.keys':
      exactKeys(request, ['action', 'keys', 'processId'], 'request');
      return {
        action,
        processId: positiveInteger(request.processId, 'process_id'),
        keys: boundedText(request.keys, 'keys', { max: 2_048 })
      };
    default:
      throw new Error('desktop_action_not_supported');
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function normalizeDesktopRequest(request) {
  return Object.freeze(normalizeRequestShape(request));
}

export function desktopRequestFingerprint(request) {
  const normalized = normalizeDesktopRequest(request);
  return createHash('sha256').update(JSON.stringify(canonical({ version: DESKTOP_BRIDGE_VERSION, request: normalized }))).digest('hex');
}

export function desktopActionRisk(action) {
  if (!allowedActions.has(action)) throw new Error('desktop_action_not_supported');
  return interactiveActions.has(action) ? 'interactive-host-write' : 'host-read';
}

export function desktopActionRequiresApproval(action) {
  return interactiveActions.has(action);
}

function defaultPowerShellExecutable({ platform = process.platform, environment = process.env } = {}) {
  if (platform === 'win32') {
    const root = boundedText(String(environment.SystemRoot ?? environment.SYSTEMROOT ?? 'C:\\Windows'), 'system_root', { max: 260 });
    return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  }
  return '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
}

function bridgeSupported({ platform = process.platform, environment = process.env } = {}) {
  if (platform === 'win32') return true;
  return platform === 'linux' && Boolean(environment.WSL_INTEROP && environment.WSL_DISTRO_NAME);
}

function bridgeEnvironment({ platform = process.platform, environment = process.env, home = homedir() } = {}) {
  if (platform === 'win32') {
    const result = {};
    for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'PATH']) {
      if (environment[name] !== undefined) result[name] = String(environment[name]);
    }
    return result;
  }
  return {
    PATH: '/usr/bin:/bin',
    HOME: resolve(home),
    WSL_INTEROP: boundedText(String(environment.WSL_INTEROP ?? ''), 'wsl_interop', { max: 4_096 }),
    WSL_DISTRO_NAME: boundedText(String(environment.WSL_DISTRO_NAME ?? ''), 'wsl_distro_name', { max: 128 })
  };
}

function payloadBase64(request) {
  return Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
}

export function renderDesktopPowerShell(request) {
  const normalized = normalizeDesktopRequest(request);
  const payload = payloadBase64(normalized);
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))`,
    '$request = $payloadJson | ConvertFrom-Json',
    'function Emit([object]$value) { $value | ConvertTo-Json -Compress -Depth 8 }',
    'function RequireWindow([int]$processId) {',
    '  $process = Get-Process -Id $processId -ErrorAction Stop',
    "  if ($process.MainWindowHandle -eq 0) { throw 'desktop_window_not_found' }",
    '  return $process',
    '}',
    "switch ($request.action) {",
    "  'system.info' {",
    "    Emit ([PSCustomObject]@{ action='system.info'; computerName=$env:COMPUTERNAME; userName=$env:USERNAME; osVersion=[Environment]::OSVersion.VersionString; powershellVersion=$PSVersionTable.PSVersion.ToString(); architecture=$env:PROCESSOR_ARCHITECTURE })",
    '    break',
    '  }',
    "  'process.list' {",
    `    $items = @(Get-Process | Sort-Object ProcessName, Id | Select-Object -First ${maxWindows} @{n='id';e={$_.Id}}, @{n='name';e={$_.ProcessName}}, @{n='windowTitle';e={$_.MainWindowTitle}})`,
    "    Emit ([PSCustomObject]@{ action='process.list'; items=$items })",
    '    break',
    '  }',
    "  'window.list' {",
    `    $items = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object ProcessName, Id | Select-Object -First ${maxWindows} @{n='processId';e={$_.Id}}, @{n='processName';e={$_.ProcessName}}, @{n='title';e={$_.MainWindowTitle}}, @{n='handle';e={$_.MainWindowHandle.ToInt64()}})`,
    "    Emit ([PSCustomObject]@{ action='window.list'; items=$items })",
    '    break',
    '  }',
    "  'screen.capture' {",
    '    Add-Type -AssemblyName System.Windows.Forms',
    '    Add-Type -AssemblyName System.Drawing',
    '    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    "    if ($bounds.Width -le 0 -or $bounds.Height -le 0) { throw 'desktop_screen_unavailable' }",
    '    $source = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
    '    $graphics = [System.Drawing.Graphics]::FromImage($source)',
    '    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)',
    '    $graphics.Dispose()',
    '    $target = $source',
    '    if ($source.Width -gt 1280) {',
    '      $height = [Math]::Max(1, [int][Math]::Round($source.Height * 1280.0 / $source.Width))',
    '      $target = New-Object System.Drawing.Bitmap 1280, $height',
    '      $scaledGraphics = [System.Drawing.Graphics]::FromImage($target)',
    '      $scaledGraphics.DrawImage($source, 0, 0, $target.Width, $target.Height)',
    '      $scaledGraphics.Dispose()',
    '    }',
    '    $stream = New-Object System.IO.MemoryStream',
    "    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1",
    "    if ($null -eq $codec) { throw 'desktop_jpeg_encoder_unavailable' }",
    '    $encoderParameters = New-Object System.Drawing.Imaging.EncoderParameters 1',
    '    $encoderParameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]55)',
    '    $target.Save($stream, $codec, $encoderParameters)',
    '    $bytes = $stream.ToArray()',
    "    if ($bytes.Length -gt 750000) { throw 'desktop_screenshot_too_large' }",
    '    $sha = [BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash($bytes)).Replace("-", "").ToLowerInvariant()',
    "    Emit ([PSCustomObject]@{ action='screen.capture'; mimeType='image/jpeg'; width=$target.Width; height=$target.Height; originalWidth=$source.Width; originalHeight=$source.Height; originX=$bounds.X; originY=$bounds.Y; sha256=$sha; imageBase64=[Convert]::ToBase64String($bytes) })",
    '    $stream.Dispose()',
    '    $encoderParameters.Dispose()',
    '    if ($target -ne $source) { $target.Dispose() }',
    '    $source.Dispose()',
    '    break',
    '  }',
    "  'url.open' {",
    '    Start-Process -FilePath ([string]$request.url) | Out-Null',
    "    Emit ([PSCustomObject]@{ action='url.open'; launched=$true; url=[string]$request.url })",
    '    break',
    '  }',
    "  'app.launch' {",
    '    $argumentList = @($request.args | ForEach-Object { [string]$_ })',
    '    if ($argumentList.Count -gt 0) { $process = Start-Process -FilePath ([string]$request.executable) -ArgumentList $argumentList -PassThru }',
    '    else { $process = Start-Process -FilePath ([string]$request.executable) -PassThru }',
    "    Emit ([PSCustomObject]@{ action='app.launch'; launched=$true; processId=$process.Id })",
    '    break',
    '  }',
    "  'window.focus' {",
    '    $process = RequireWindow ([int]$request.processId)',
    "    Add-Type -Namespace DesktopBridge -Name NativeWindow -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);'",
    "    if (-not [DesktopBridge.NativeWindow]::SetForegroundWindow($process.MainWindowHandle)) { throw 'desktop_focus_failed' }",
    "    Emit ([PSCustomObject]@{ action='window.focus'; focused=$true; processId=$process.Id })",
    '    break',
    '  }',
    "  'input.click' {",
    "    Add-Type -Namespace DesktopBridge -Name NativeInput -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int X, int Y); [DllImport(\"user32.dll\")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);'",
    "    if (-not [DesktopBridge.NativeInput]::SetCursorPos([int]$request.x, [int]$request.y)) { throw 'desktop_cursor_move_failed' }",
    '    [DesktopBridge.NativeInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)',
    '    [DesktopBridge.NativeInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)',
    "    Emit ([PSCustomObject]@{ action='input.click'; clicked=$true; x=[int]$request.x; y=[int]$request.y })",
    '    break',
    '  }',
    "  'input.keys' {",
    '    $process = RequireWindow ([int]$request.processId)',
    "    Add-Type -Namespace DesktopBridge -Name NativeWindow -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);'",
    "    if (-not [DesktopBridge.NativeWindow]::SetForegroundWindow($process.MainWindowHandle)) { throw 'desktop_focus_failed' }",
    '    Add-Type -AssemblyName System.Windows.Forms',
    '    [System.Windows.Forms.SendKeys]::SendWait([string]$request.keys)',
    "    Emit ([PSCustomObject]@{ action='input.keys'; sent=$true; processId=$process.Id })",
    '    break',
    '  }',
    "  default { throw 'desktop_action_not_supported' }",
    '}',
    ''
  ].join('\r\n');
}

export function encodePowerShellCommand(script) {
  return Buffer.from(boundedText(script, 'powershell_script', { max: 128 * 1024 }), 'utf16le').toString('base64');
}

export class WindowsDesktopBridge {
  constructor({
    platform = process.platform,
    environment = process.env,
    home = homedir(),
    commandRunner = runLocalCommand,
    powershellExecutable = null
  } = {}) {
    this.platform = platform;
    this.environment = environment;
    this.home = resolve(home);
    this.commandRunner = commandRunner;
    this.powershellExecutable = powershellExecutable ?? defaultPowerShellExecutable({ platform, environment });
  }

  plan(request) {
    const normalized = normalizeDesktopRequest(request);
    const fingerprint = desktopRequestFingerprint(normalized);
    return Object.freeze({
      version: DESKTOP_BRIDGE_VERSION,
      supported: bridgeSupported({ platform: this.platform, environment: this.environment }),
      action: normalized.action,
      request: normalized,
      risk: desktopActionRisk(normalized.action),
      requiresApproval: desktopActionRequiresApproval(normalized.action),
      fingerprint
    });
  }

  async status() {
    const supported = bridgeSupported({ platform: this.platform, environment: this.environment });
    if (!supported) return { version: DESKTOP_BRIDGE_VERSION, supported: false, ready: false, reason: 'windows_desktop_bridge_unavailable' };
    let info;
    try { info = await lstat(this.powershellExecutable); } catch (error) {
      if (error.code === 'ENOENT') return { version: DESKTOP_BRIDGE_VERSION, supported: true, ready: false, reason: 'powershell_not_found', powershellExecutable: this.powershellExecutable };
      throw error;
    }
    const ready = info.isFile();
    return {
      version: DESKTOP_BRIDGE_VERSION,
      supported: true,
      ready,
      reason: ready ? null : 'powershell_not_regular_file',
      powershellExecutable: this.powershellExecutable
    };
  }

  async execute(request, { approvedFingerprint = null, timeoutMs = 20_000, maxOutputBytes = 256 * 1024 } = {}) {
    const plan = this.plan(request);
    if (!plan.supported) throw new Error('windows_desktop_bridge_unavailable');
    if (plan.requiresApproval && approvedFingerprint !== plan.fingerprint) throw new Error('desktop_action_approval_required');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) throw new Error('desktop_timeout_invalid');
    if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1_024 || maxOutputBytes > 2 * 1024 * 1024) throw new Error('desktop_output_limit_invalid');

    const script = renderDesktopPowerShell(plan.request);
    const encoded = encodePowerShellCommand(script);
    const result = await this.commandRunner(this.powershellExecutable, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encoded
    ], {
      cwd: this.home,
      env: bridgeEnvironment({ platform: this.platform, environment: this.environment, home: this.home }),
      timeoutMs,
      maxOutputBytes
    });

    if (result.exitCode !== 0) {
      const detail = String(result.stderr ?? '').trim().slice(0, 1_000);
      throw new Error(detail ? `desktop_action_failed:${detail}` : 'desktop_action_failed');
    }
    const output = String(result.stdout ?? '').trim();
    if (!output) throw new Error('desktop_action_empty_output');
    let parsed;
    try { parsed = JSON.parse(output); } catch { throw new Error('desktop_action_invalid_output'); }
    return {
      version: DESKTOP_BRIDGE_VERSION,
      fingerprint: plan.fingerprint,
      action: plan.action,
      risk: plan.risk,
      evidence: parsed
    };
  }
}
