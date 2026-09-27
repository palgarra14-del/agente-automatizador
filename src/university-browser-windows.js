import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  assertUniversityUrlAllowed,
  normalizeUniversityCdpEndpoint,
  normalizeUniversityOrigins
} from './university-browser.js';

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
  timeoutMs = 20_000
} = {}) {
  const endpoint = normalizeUniversityCdpEndpoint(cdpEndpoint);
  const origins = normalizeUniversityOrigins(allowedOrigins);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new Error('university_windows_bridge_timeout_invalid');
  }

  let helperWindowsPath = null;

  async function windowsPath() {
    if (helperWindowsPath) return helperWindowsPath;
    const result = await runner('/usr/bin/wslpath', ['-w', helperPath], {
      timeout: 5_000,
      maxBuffer: 10_000
    });
    helperWindowsPath = String(result.stdout || '').trim();
    if (!/^\\\\wsl(?:\.localhost)?\\/i.test(helperWindowsPath)) {
      throw new Error('university_windows_bridge_helper_path_invalid');
    }
    return helperWindowsPath;
  }

  async function invoke(action, { targetId = null, url = null } = {}) {
    const helper = await windowsPath();
    const environment = {
      WSLENV: 'UNIVERSITY_CDP_ENDPOINT/w:UNIVERSITY_ALLOWED_ORIGINS/w:UNIVERSITY_BRIDGE_ACTION/w:UNIVERSITY_TARGET_ID/w:UNIVERSITY_URL/w',
      UNIVERSITY_CDP_ENDPOINT: endpoint,
      UNIVERSITY_ALLOWED_ORIGINS: origins.join(','),
      UNIVERSITY_BRIDGE_ACTION: action
    };
    if (targetId !== null) environment.UNIVERSITY_TARGET_ID = String(targetId);
    if (url !== null) environment.UNIVERSITY_URL = assertUniversityUrlAllowed(String(url), origins);
    let result;
    try {
      result = await runner(windowsNodePath, [helper], {
        env: environment,
        timeout: timeoutMs,
        maxBuffer: 500_000
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
      return (await invoke('read', { targetId })).page;
    },
    async navigatePage(targetId, url) {
      return (await invoke('navigate', { targetId, url })).page;
    },
    async readUrl(url) {
      return (await invoke('read_url', { url })).page;
    }
  });
}
