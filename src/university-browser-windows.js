import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { normalizeUniversityCdpEndpoint, normalizeUniversityOrigins } from './university-browser.js';

const execFile = promisify(nodeExecFile);
const DEFAULT_WINDOWS_NODE = '/mnt/c/Program Files/nodejs/node.exe';
const DEFAULT_HELPER = fileURLToPath(new URL('../scripts/university-browser-windows-bridge.cjs', import.meta.url));

function parseResult(stdout) {
  let value;
  try { value = JSON.parse(String(stdout || '').trim()); }
  catch { throw new Error('university_windows_bridge_output_invalid'); }
  if (!value || value.ok !== true) throw new Error('university_windows_bridge_failed');
  return value;
}

export function createWindowsUniversityBrowserBridge({
  cdpEndpoint = 'http://127.0.0.1:9223',
  allowedOrigins,
  windowsNodePath = DEFAULT_WINDOWS_NODE,
  helperPath = DEFAULT_HELPER,
  runner = execFile,
  timeoutMs = 15000
} = {}) {
  const endpoint = normalizeUniversityCdpEndpoint(cdpEndpoint);
  const origins = normalizeUniversityOrigins(allowedOrigins);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw new Error('university_windows_bridge_timeout_invalid');
  }

  let helperWindowsPath = null;

  async function windowsPath() {
    if (helperWindowsPath) return helperWindowsPath;
    const result = await runner('/usr/bin/wslpath', ['-w', helperPath], {
      timeout: 5000,
      maxBuffer: 10000
    });
    helperWindowsPath = String(result.stdout || '').trim();
    if (!/^\\\\wsl(?:\.localhost)?\\/i.test(helperWindowsPath)) {
      throw new Error('university_windows_bridge_helper_path_invalid');
    }
    return helperWindowsPath;
  }

  async function invoke(action, targetId = null) {
    const helper = await windowsPath();
    const environment = {
      WSLENV: 'UNIVERSITY_CDP_ENDPOINT/w:UNIVERSITY_ALLOWED_ORIGINS/w:UNIVERSITY_BRIDGE_ACTION/w:UNIVERSITY_TARGET_ID/w',
      UNIVERSITY_CDP_ENDPOINT: endpoint,
      UNIVERSITY_ALLOWED_ORIGINS: origins.join(','),
      UNIVERSITY_BRIDGE_ACTION: action
    };
    if (targetId !== null) environment.UNIVERSITY_TARGET_ID = String(targetId);
    let result;
    try {
      result = await runner(windowsNodePath, [helper], {
        env: environment,
        timeout: timeoutMs,
        maxBuffer: 200000
      });
    } catch (error) {
      throw new Error('university_windows_bridge_process_failed', { cause: error });
    }
    return parseResult(result.stdout);
  }

  return Object.freeze({
    endpoint,
    origins,
    async status() {
      return (await invoke('status')).status;
    },
    async listReadablePages() {
      return (await invoke('list')).pages;
    },
    async readPage(targetId) {
      return (await invoke('read', targetId)).page;
    }
  });
}
