import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WindowsDesktopBridge,
  desktopActionRequiresApproval,
  desktopActionRisk,
  desktopRequestFingerprint,
  encodePowerShellCommand,
  normalizeDesktopRequest,
  renderDesktopPowerShell
} from '../src/desktop-bridge.js';

const wslEnvironment = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/home/tester',
  WSL_INTEROP: '/run/WSL/123_interop',
  WSL_DISTRO_NAME: 'Ubuntu',
  GITHUB_TOKEN: 'must-not-leak',
  OPENAI_API_KEY: 'must-not-leak'
});

test('desktop request schema is strict and fingerprints normalized requests', () => {
  assert.deepEqual(normalizeDesktopRequest({ action: 'system.info' }), { action: 'system.info' });
  assert.throws(() => normalizeDesktopRequest({ action: 'system.info', surprise: true }), /desktop_request_fields_invalid/);
  assert.throws(() => normalizeDesktopRequest({ action: 'url.open', url: 'file:///etc/passwd' }), /desktop_url_scheme_not_allowed/);
  assert.throws(() => normalizeDesktopRequest({ action: 'input.click', x: -1, y: 10 }), /desktop_x_invalid/);
  assert.throws(() => normalizeDesktopRequest({ action: 'unknown' }), /desktop_action_not_supported/);

  const left = desktopRequestFingerprint({ action: 'app.launch', executable: 'notepad.exe', args: ['a.txt'] });
  const right = desktopRequestFingerprint({ executable: 'notepad.exe', args: ['a.txt'], action: 'app.launch' });
  assert.equal(left, right);
  assert.equal(left.length, 64);
});

test('desktop action risk keeps observation separate from host interaction', () => {
  assert.equal(desktopActionRisk('system.info'), 'host-read');
  assert.equal(desktopActionRequiresApproval('system.info'), false);
  assert.equal(desktopActionRisk('window.list'), 'host-read');
  assert.equal(desktopActionRequiresApproval('window.list'), false);
  assert.equal(desktopActionRisk('input.keys'), 'interactive-host-write');
  assert.equal(desktopActionRequiresApproval('input.keys'), true);
});

test('PowerShell rendering carries untrusted values only inside an encoded JSON payload', () => {
  const marker = "'; Write-Output PWNED; #";
  const request = { action: 'url.open', url: `https://example.com/?q=${encodeURIComponent(marker)}` };
  const script = renderDesktopPowerShell(request);
  assert.equal(script.includes(marker), false);
  assert.match(script, /FromBase64String/);
  const encoded = encodePowerShellCommand(script);
  assert.match(encoded, /^[A-Za-z0-9+/=]+$/);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), script);
});

test('read-only desktop observation executes without approval and strips secret environment variables', async () => {
  const calls = [];
  const bridge = new WindowsDesktopBridge({
    platform: 'linux',
    environment: wslEnvironment,
    home: '/home/tester',
    powershellExecutable: '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    commandRunner: async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        exitCode: 0,
        stdout: JSON.stringify({ action: 'system.info', computerName: 'PC', userName: 'tester' }),
        stderr: ''
      };
    }
  });

  const result = await bridge.execute({ action: 'system.info' });
  assert.equal(result.action, 'system.info');
  assert.equal(result.risk, 'host-read');
  assert.equal(result.evidence.computerName, 'PC');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command.endsWith('powershell.exe'), true);
  assert.equal(calls[0].args.includes('-EncodedCommand'), true);
  assert.equal(calls[0].options.env.GITHUB_TOKEN, undefined);
  assert.equal(calls[0].options.env.OPENAI_API_KEY, undefined);
  assert.equal(calls[0].options.env.WSL_DISTRO_NAME, 'Ubuntu');
});

test('interactive desktop action fails before process creation without exact approval fingerprint', async () => {
  let calls = 0;
  const bridge = new WindowsDesktopBridge({
    platform: 'linux',
    environment: wslEnvironment,
    home: '/home/tester',
    commandRunner: async () => {
      calls += 1;
      return { exitCode: 0, stdout: '{}', stderr: '' };
    }
  });
  const request = { action: 'input.click', x: 100, y: 200 };
  const plan = bridge.plan(request);
  assert.equal(plan.requiresApproval, true);
  assert.equal(plan.risk, 'interactive-host-write');
  await assert.rejects(bridge.execute(request), /desktop_action_approval_required/);
  await assert.rejects(bridge.execute(request, { approvedFingerprint: '0'.repeat(64) }), /desktop_action_approval_required/);
  assert.equal(calls, 0);
});

test('interactive desktop action executes only for the fingerprinted request', async () => {
  const calls = [];
  const bridge = new WindowsDesktopBridge({
    platform: 'linux',
    environment: wslEnvironment,
    home: '/home/tester',
    commandRunner: async (command, args, options) => {
      calls.push({ command, args, options });
      return { exitCode: 0, stdout: JSON.stringify({ action: 'window.focus', focused: true, processId: 42 }), stderr: '' };
    }
  });
  const request = { action: 'window.focus', processId: 42 };
  const plan = bridge.plan(request);
  const result = await bridge.execute(request, { approvedFingerprint: plan.fingerprint });
  assert.equal(result.fingerprint, plan.fingerprint);
  assert.deepEqual(result.evidence, { action: 'window.focus', focused: true, processId: 42 });
  assert.equal(calls.length, 1);

  const changed = { action: 'window.focus', processId: 43 };
  await assert.rejects(bridge.execute(changed, { approvedFingerprint: plan.fingerprint }), /desktop_action_approval_required/);
  assert.equal(calls.length, 1);
});

test('desktop bridge reports unsupported hosts without invoking Windows', async () => {
  const bridge = new WindowsDesktopBridge({
    platform: 'linux',
    environment: {},
    home: '/tmp',
    commandRunner: async () => { throw new Error('must not execute'); }
  });
  assert.deepEqual(await bridge.status(), {
    version: 1,
    supported: false,
    ready: false,
    reason: 'windows_desktop_bridge_unavailable'
  });
  await assert.rejects(bridge.execute({ action: 'system.info' }), /windows_desktop_bridge_unavailable/);
});
