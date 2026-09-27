import assert from 'node:assert/strict';
import test from 'node:test';
import { createWindowsUniversityBrowserBridge } from '../src/university-browser-windows.js';

test('Windows bridge passes only explicit university environment to helper', async () => {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === '/usr/bin/wslpath') {
      return { stdout: '\\\\wsl.localhost\\Ubuntu\\repo\\helper.cjs\n', stderr: '' };
    }
    if (options.env.UNIVERSITY_BRIDGE_ACTION === 'status') {
      return { stdout: JSON.stringify({ ok: true, status: { ready: true } }), stderr: '' };
    }
    throw new Error('unexpected action');
  };

  const bridge = createWindowsUniversityBrowserBridge({
    allowedOrigins: ['https://campus.example'],
    runner
  });
  assert.deepEqual(await bridge.status(), { ready: true });
  const execution = calls[1];
  assert.equal(execution.command, '/mnt/c/Program Files/nodejs/node.exe');
  assert.deepEqual(Object.keys(execution.options.env).sort(), [
    'UNIVERSITY_ALLOWED_ORIGINS',
    'UNIVERSITY_BRIDGE_ACTION',
    'UNIVERSITY_CDP_ENDPOINT',
    'WSLENV'
  ]);
  assert.equal(execution.options.env.UNIVERSITY_ALLOWED_ORIGINS, 'https://campus.example');
});

test('Windows bridge forwards read target but never caller process environment', async () => {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === '/usr/bin/wslpath') return { stdout: '\\\\wsl.localhost\\Ubuntu\\repo\\helper.cjs\n' };
    return {
      stdout: JSON.stringify({
        ok: true,
        page: { targetId: options.env.UNIVERSITY_TARGET_ID, url: 'https://campus.example/a', title: 'A', text: 'Visible' }
      })
    };
  };
  const bridge = createWindowsUniversityBrowserBridge({ allowedOrigins: ['https://campus.example'], runner });
  const page = await bridge.readPage('target-1');
  assert.equal(page.targetId, 'target-1');
  assert.equal(calls[1].options.env.PATH, undefined);
  assert.equal(calls[1].options.env.OPENAI_API_KEY, undefined);
});

test('Windows bridge fails closed on malformed helper output and invalid helper path', async () => {
  let calls = 0;
  const badOutput = async (command) => {
    calls += 1;
    if (command === '/usr/bin/wslpath') return { stdout: '\\\\wsl.localhost\\Ubuntu\\repo\\helper.cjs\n' };
    return { stdout: 'not-json' };
  };
  const first = createWindowsUniversityBrowserBridge({ allowedOrigins: ['https://campus.example'], runner: badOutput });
  await assert.rejects(() => first.status(), /output_invalid/);
  assert.equal(calls, 2);

  const badPath = async () => ({ stdout: 'C:\\temp\\helper.cjs\n' });
  const second = createWindowsUniversityBrowserBridge({ allowedOrigins: ['https://campus.example'], runner: badPath });
  await assert.rejects(() => second.status(), /helper_path_invalid/);
});


test('Windows bridge opens only allowlisted read URLs and forwards no ambient environment', async () => {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === '/usr/bin/wslpath') {
      return { stdout: '\\\\wsl.localhost\\Ubuntu\\repo\\helper.cjs\n' };
    }
    return {
      stdout: JSON.stringify({
        ok: true,
        page: {
          targetId: 'temp-1',
          url: options.env.UNIVERSITY_URL,
          title: 'Course',
          text: 'Visible course content',
          links: [{ url: 'https://campus.example/mod/assign/view.php?id=7', text: 'Task' }]
        }
      })
    };
  };

  const bridge = createWindowsUniversityBrowserBridge({
    allowedOrigins: ['https://campus.example'],
    runner
  });
  const page = await bridge.readUrl('https://campus.example/course/view.php?id=1#section-2');
  assert.equal(page.url, 'https://campus.example/course/view.php?id=1');
  assert.equal(calls[1].options.env.UNIVERSITY_URL, 'https://campus.example/course/view.php?id=1');
  assert.equal(calls[1].options.env.PATH, undefined);
  await assert.rejects(
    () => bridge.readUrl('https://evil.example/course/view.php?id=1'),
    /origin_forbidden/
  );
});

test('Windows bridge can navigate the dedicated page using only explicit target and URL', async () => {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === '/usr/bin/wslpath') {
      return { stdout: '\\\\wsl.localhost\\Ubuntu\\repo\\helper.cjs\n' };
    }
    return {
      stdout: JSON.stringify({
        ok: true,
        page: {
          targetId: options.env.UNIVERSITY_TARGET_ID,
          url: options.env.UNIVERSITY_URL,
          title: 'Course',
          text: 'Course content',
          links: []
        }
      })
    };
  };
  const bridge = createWindowsUniversityBrowserBridge({
    allowedOrigins: ['https://campus.example'],
    runner
  });
  const page = await bridge.navigatePage(
    'target-1',
    'https://campus.example/course/view.php?id=7'
  );
  assert.equal(page.targetId, 'target-1');
  assert.equal(calls[1].options.env.UNIVERSITY_BRIDGE_ACTION, 'navigate');
  assert.equal(
    calls[1].options.env.UNIVERSITY_URL,
    'https://campus.example/course/view.php?id=7'
  );
});
