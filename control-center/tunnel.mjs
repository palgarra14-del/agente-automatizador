import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { quickTunnelExpired } from './tunnel-policy.mjs';

const binary = process.env.CLOUDFLARED_BIN || join(homedir(), '.local', 'bin', 'cloudflared');
const target = process.env.AGENT_CONTROL_TARGET || 'http://127.0.0.1:8787';
const configDir = join(homedir(), '.config', 'agent-control-center');
const urlFile = process.env.AGENT_CONTROL_TUNNEL_URL_FILE || join(configDir, 'tunnel-url');
const gistIdFile = process.env.AGENT_CONTROL_LOCATOR_GIST_ID_FILE || join(configDir, 'locator-gist-id');
await mkdir(dirname(urlFile), { recursive:true, mode:0o700 });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function locatorGistId() {
  try {
    const value = (await readFile(gistIdFile, 'utf8')).trim();
    return /^[a-f0-9]{20,64}$/i.test(value) ? value : null;
  } catch {
    return null;
  }
}

async function publishLocator(url) {
  const gistId = await locatorGistId();
  if (!gistId) return false;

  const payload = JSON.stringify({
    files: {
      'tunnel-url': { content: url + '\n' }
    }
  });
  return new Promise((resolve, reject) => {
    const gh = spawn('gh', ['api', '--method', 'PATCH', `/gists/${gistId}`, '--input', '-'], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { ...process.env, GH_HOST: 'github.com' }
    });
    let stderr = '';
    gh.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    gh.on('error', reject);
    gh.on('exit', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`locator_publish_failed:${code}:${stderr.trim()}`));
    });
    gh.stdin.end(payload);
  });
}

async function publishLocatorWithRetry(url) {
  for (const delay of [0, 2_000, 5_000, 10_000]) {
    if (delay) await sleep(delay);
    try {
      if (await publishLocator(url)) {
        console.log('AGENT_CONTROL_LOCATOR_UPDATED=1');
        return;
      }
      console.log('AGENT_CONTROL_LOCATOR_UNCONFIGURED=1');
      return;
    } catch (error) {
      if (delay === 10_000) console.error(String(error.message || error));
    }
  }
}

const child = spawn(binary, ['tunnel', '--url', target, '--no-autoupdate'], { stdio:['ignore','pipe','pipe'] });
let saved = false;
let restartingExpiredTunnel = false;
const handle = async (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  if (!restartingExpiredTunnel && quickTunnelExpired(text)) {
    restartingExpiredTunnel = true;
    console.error('AGENT_CONTROL_TUNNEL_EXPIRED=1');
    child.kill('SIGTERM');
    return;
  }
  if (saved) return;
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (!match) return;
  saved = true;
  await writeFile(urlFile, match[0] + '\n', { mode:0o600 });
  console.log('AGENT_CONTROL_PUBLIC_URL=' + match[0]);
  await publishLocatorWithRetry(match[0]);
};
child.stdout.on('data', (chunk) => handle(chunk).catch(console.error));
child.stderr.on('data', (chunk) => handle(chunk).catch(console.error));
child.on('exit', (code, signal) => process.exitCode = code ?? (signal ? 1 : 0));
for (const signal of ['SIGINT','SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
