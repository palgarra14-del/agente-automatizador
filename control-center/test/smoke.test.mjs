import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { quickTunnelExpired } from '../tunnel-policy.mjs';

const root = resolve(import.meta.dirname, '..');
const port = 18787 + Math.floor(Math.random() * 500);

async function waitFor(url, timeout=5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { return await fetch(url); } catch { /* server may still be starting */ }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error('server_start_timeout');
}

test('control center serves UI and protects API', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-control-test-'));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      AGENT_CONTROL_PORT: String(port),
      AGENT_ROOT: resolve(root, '..')
    },
    stdio: 'ignore'
  });
  try {
    const base = 'http://127.0.0.1:' + port;
    const homeResponse = await waitFor(base + '/');
    assert.equal(homeResponse.status, 200);
    assert.match(await homeResponse.text(), /Agent Control/);

    const denied = await fetch(base + '/api/status');
    assert.equal(denied.status, 401);

    const wrong = await fetch(base + '/api/login', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({pin:'incorrecto'})
    });
    assert.equal(wrong.status, 401);

    const tokenPath = join(home, '.config', 'agent-control-center', 'access-token');
    const token = (await readFile(tokenPath, 'utf8')).trim();
    assert.ok(token.length >= 12);

    const login = await fetch(base + '/api/login', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({pin:token})
    });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie') || '', /agent_session=/);

    const sessionCookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const changed = await fetch(base + '/api/change-pin', {
      method:'POST',
      headers:{'content-type':'application/json', cookie:sessionCookie},
      body:JSON.stringify({pin:'11111'})
    });
    assert.equal(changed.status, 200);
    assert.match(changed.headers.get('set-cookie') || '', /agent_session=/);

    const oldLogin = await fetch(base + '/api/login', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({pin:token})
    });
    assert.equal(oldLogin.status, 401);

    const newLogin = await fetch(base + '/api/login', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({pin:'11111'})
    });
    assert.equal(newLogin.status, 200);
  } finally {
    child.kill('SIGTERM');
    await rm(home, {recursive:true, force:true});
  }
});


test('control center accepts a user-selected five-character PIN', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-control-pin-test-'));
  const pin = '11111';
  const tokenPath = join(home, '.config', 'agent-control-center', 'access-token');
  await mkdir(join(home, '.config', 'agent-control-center'), { recursive:true });
  await writeFile(tokenPath, pin + '\n', { mode:0o600 });
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      AGENT_CONTROL_PORT: String(port + 1),
      AGENT_ROOT: resolve(root, '..')
    },
    stdio: 'ignore'
  });
  try {
    const base = 'http://127.0.0.1:' + (port + 1);
    await waitFor(base + '/');
    const login = await fetch(base + '/api/login', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({pin})
    });
    assert.equal(login.status, 200);
  } finally {
    child.kill('SIGTERM');
    await rm(home, {recursive:true, force:true});
  }
});

test('quick tunnel expiry detection is narrow and fail-safe', () => {
  assert.equal(quickTunnelExpired('ERR Register tunnel error from server side error="Unauthorized: Tunnel not found"'), true);
  assert.equal(quickTunnelExpired('ERR Register tunnel error from server side error="Unauthorized: invalid token"'), false);
  assert.equal(quickTunnelExpired('Registered tunnel connection'), false);
});
