import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CodexDesktopPlanner,
  buildDesktopPlannerPrompt,
  normalizeDesktopPlannerDecision
} from '../src/desktop-planner.js';

function screenFixture() {
  const bytes = Buffer.from('fake-jpeg-payload');
  return {
    action: 'screen.capture',
    mimeType: 'image/jpeg',
    width: 1280,
    height: 720,
    originalWidth: 2560,
    originalHeight: 1440,
    originX: -1920,
    originY: 0,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    imageBase64: bytes.toString('base64')
  };
}

function windowsFixture() {
  return {
    action: 'window.list',
    items: [
      { processId: 42, processName: 'chrome', title: 'Example', handle: 12345 }
    ]
  };
}

test('desktop planner decision accepts only one strict governed action', () => {
  assert.deepEqual(normalizeDesktopPlannerDecision({
    status: 'act',
    reason: 'The visible browser is the target.',
    action: { action: 'window.focus', processId: 42 }
  }), {
    status: 'act',
    reason: 'The visible browser is the target.',
    action: { action: 'window.focus', processId: 42 }
  });

  assert.throws(() => normalizeDesktopPlannerDecision({
    status: 'act',
    reason: 'Try a shell.',
    action: { action: 'shell.run', command: 'whoami' }
  }), /desktop_action_not_supported/);

  assert.throws(() => normalizeDesktopPlannerDecision({
    status: 'done',
    reason: 'Done',
    summary: 'Done',
    extra: true
  }), /desktop_planner_decision_fields_invalid/);
});

test('planner prompt treats screen content as untrusted and explains coordinate mapping', () => {
  const prompt = buildDesktopPlannerPrompt({
    goal: 'Open the visible application',
    screen: {
      action: 'screen.capture',
      mimeType: 'image/jpeg',
      width: 1280,
      height: 720,
      originalWidth: 2560,
      originalHeight: 1440,
      originX: -1920,
      originY: 0,
      sha256: '0'.repeat(64)
    },
    windows: windowsFixture().items
  });
  assert.match(prompt, /untrusted user data/);
  assert.match(prompt, /view_image/);
  assert.match(prompt, /Negative native coordinates are valid/);
  assert.match(prompt, /exactly one JSON object/);
  assert.doesNotMatch(prompt, /imageBase64/);
});

test('planner rejects screenshot tampering before starting a model', async () => {
  let modelStarts = 0;
  class FakeCodex {
    startThread() {
      modelStarts += 1;
      throw new Error('must not start');
    }
  }
  const home = await mkdtemp(join(tmpdir(), 'desktop-planner-home-'));
  try {
    const screen = screenFixture();
    screen.sha256 = '0'.repeat(64);
    const planner = new CodexDesktopPlanner({
      CodexClient: FakeCodex,
      home,
      platform: 'linux',
      nativeRuntimePath: '/opt/codex-runtime',
      environment: { PATH: '/usr/bin:/bin' }
    });
    await assert.rejects(planner.plan({
      goal: 'Inspect the desktop',
      screen,
      windows: windowsFixture()
    }), /desktop_planner_screen_digest_mismatch/);
    assert.equal(modelStarts, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('planner runs Codex with read-only isolated computer-use disabled and validates one action', async () => {
  const seen = {};
  class FakeCodex {
    constructor(options) { seen.clientOptions = options; }
    startThread(options) {
      seen.threadOptions = options;
      return {
        id: 'desktop-thread-1',
        run: async (prompt) => {
          seen.prompt = prompt;
          return {
            finalResponse: JSON.stringify({
              status: 'act',
              reason: 'The browser window is visible and can be focused first.',
              action: { action: 'window.focus', processId: 42 }
            }),
            usage: { input_tokens: 100, output_tokens: 20 }
          };
        }
      };
    }
  }

  const home = await mkdtemp(join(tmpdir(), 'desktop-planner-home-'));
  try {
    const planner = new CodexDesktopPlanner({
      CodexClient: FakeCodex,
      home,
      platform: 'linux',
      nativeRuntimePath: '/opt/codex-runtime',
      environment: {
        PATH: '/usr/bin:/bin',
        OPENAI_API_KEY: 'test-key',
        GITHUB_TOKEN: 'must-not-be-inherited'
      },
      codexHomeFactory: async () => ({
        path: home,
        cleanup: async () => {}
      })
    });
    const result = await planner.plan({
      goal: 'Continue in the visible browser',
      screen: screenFixture(),
      windows: windowsFixture()
    });

    assert.equal(result.decision.status, 'act');
    assert.deepEqual(result.decision.action, { action: 'window.focus', processId: 42 });
    assert.equal(result.codexThreadId, 'desktop-thread-1');
    assert.match(seen.prompt, /Continue in the visible browser/);
    assert.match(seen.prompt, /view_image/);
    assert.equal(seen.threadOptions.approvalPolicy, 'never');
    assert.equal(seen.threadOptions.webSearchMode, 'disabled');
    assert.ok(seen.clientOptions.configOverrides.includes('features.computer_use=false'));
    assert.ok(seen.clientOptions.configOverrides.includes('permissions.agent-workflow.network.enabled=false'));
    assert.equal(seen.clientOptions.env.GITHUB_TOKEN, undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('planner rejects malformed or over-authorized model output', async () => {
  class FakeCodex {
    startThread() {
      return {
        id: 'desktop-thread-invalid',
        run: async () => ({
          finalResponse: JSON.stringify({
            status: 'act',
            reason: 'Attempt to escape.',
            action: { action: 'input.click', x: 1, y: 2, command: 'extra' }
          })
        })
      };
    }
  }

  const home = await mkdtemp(join(tmpdir(), 'desktop-planner-home-'));
  try {
    const planner = new CodexDesktopPlanner({
      CodexClient: FakeCodex,
      home,
      platform: 'linux',
      nativeRuntimePath: '/opt/codex-runtime',
      environment: { PATH: '/usr/bin:/bin' },
      codexHomeFactory: async () => ({
        path: home,
        cleanup: async () => {}
      })
    });
    await assert.rejects(planner.plan({
      goal: 'Do one safe action',
      screen: screenFixture(),
      windows: windowsFixture()
    }), /desktop_request_fields_invalid/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
