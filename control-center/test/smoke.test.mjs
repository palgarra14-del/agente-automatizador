import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const port = 18787 + Math.floor(Math.random() * 500);

async function waitFor(url, timeout=5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { return await fetch(url); } catch {}
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
  } finally {
    child.kill('SIGTERM');
    await rm(home, {recursive:true, force:true});
  }
});
