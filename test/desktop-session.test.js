import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DesktopTaskSessionEngine,
  FileDesktopSessionStore,
  MemoryDesktopSessionStore
} from '../src/desktop-session.js';
import {
  desktopActionRequiresApproval,
  desktopActionRisk,
  desktopRequestFingerprint,
  normalizeDesktopRequest
} from '../src/desktop-bridge.js';

function observationScreen() {
  return {
    action: 'screen.capture',
    mimeType: 'image/jpeg',
    width: 1280,
    height: 720,
    originalWidth: 1920,
    originalHeight: 1080,
    originX: 0,
    originY: 0,
    sha256: '0'.repeat(64),
    imageBase64: 'AA=='
  };
}

class FakeBridge {
  constructor() {
    this.executed = [];
    this.observations = 0;
  }

  plan(request) {
    const normalized = normalizeDesktopRequest(request);
    return {
      action: normalized.action,
      request: normalized,
      fingerprint: desktopRequestFingerprint(normalized),
      risk: desktopActionRisk(normalized.action),
      requiresApproval: desktopActionRequiresApproval(normalized.action),
      supported: true
    };
  }

  async execute(request, { approvedFingerprint = null } = {}) {
    const normalized = normalizeDesktopRequest(request);
    if (normalized.action === 'window.list') {
      this.observations += 1;
      return {
        evidence: {
          action: 'window.list',
          items: [{ processId: 42, processName: 'notepad', title: 'Untitled - Notepad', handle: 123 }]
        }
      };
    }
    if (normalized.action === 'screen.capture') {
      this.observations += 1;
      return { evidence: observationScreen() };
    }

    const fingerprint = desktopRequestFingerprint(normalized);
    if (desktopActionRequiresApproval(normalized.action) && approvedFingerprint !== fingerprint) {
      throw new Error('desktop_action_approval_required');
    }
    this.executed.push(structuredClone(normalized));
    if (normalized.action === 'app.launch') return { evidence: { action: 'app.launch', launched: true, processId: 99 } };
    return { evidence: { action: normalized.action, ok: true } };
  }
}

test('session pauses before an interactive action and executes only the exact approved fingerprint', async () => {
  const bridge = new FakeBridge();
  let plannerCalls = 0;
  const planner = {
    async plan({ history }) {
      plannerCalls += 1;
      if (plannerCalls === 1) {
        assert.deepEqual(history, []);
        return {
          decision: {
            status: 'act',
            reason: 'Type the requested text into the visible editor.',
            action: { action: 'input.keys', processId: 42, keys: 'hello world' }
          },
          observation: { screenSha256: '0'.repeat(64), windows: 1 }
        };
      }
      assert.equal(history.length, 1);
      assert.equal(history[0].action, 'input.keys');
      assert.doesNotMatch(history[0].outcome, /hello world/);
      return {
        decision: {
          status: 'done',
          reason: 'The requested text is visible.',
          summary: 'Text entry completed.'
        },
        observation: { screenSha256: '1'.repeat(64), windows: 1 }
      };
    }
  };

  const store = new MemoryDesktopSessionStore();
  const engine = new DesktopTaskSessionEngine({
    store,
    bridge,
    planner,
    now: (() => {
      let tick = 0;
      return () => `2026-09-23T12:00:0${tick++}Z`;
    })()
  });

  const started = await engine.start('Type hello world in Notepad');
  const pending = await engine.step(started.id);
  assert.equal(pending.status, 'awaiting_approval');
  assert.equal(pending.actionCount, 0);
  assert.equal(bridge.executed.length, 0);
  assert.equal(pending.pendingAction.request.keys, 'hello world');

  await assert.rejects(
    engine.step(started.id, { approvedFingerprint: 'f'.repeat(64) }),
    /desktop_session_approval_mismatch/
  );
  assert.equal(bridge.executed.length, 0);

  const completed = await engine.step(started.id, {
    approvedFingerprint: pending.pendingAction.fingerprint
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.actionCount, 1);
  assert.equal(bridge.executed.length, 1);
  assert.deepEqual(bridge.executed[0], { action: 'input.keys', processId: 42, keys: 'hello world' });
  assert.equal(completed.pendingAction, null);
  assert.equal(completed.history.length, 1);
  assert.doesNotMatch(JSON.stringify(completed.history), /hello world/);
  assert.equal(completed.result.summary, 'Text entry completed.');
});

test('session verifies completion after consuming the final action budget', async () => {
  const bridge = new FakeBridge();
  let plannerCalls = 0;
  const planner = {
    async plan() {
      plannerCalls += 1;
      if (plannerCalls === 1) {
        return {
          decision: {
            status: 'act',
            reason: 'Focus the target.',
            action: { action: 'window.focus', processId: 42 }
          },
          observation: null
        };
      }
      return {
        decision: {
          status: 'done',
          reason: 'The target is focused.',
          summary: 'Goal completed within budget.'
        },
        observation: null
      };
    }
  };
  const engine = new DesktopTaskSessionEngine({
    store: new MemoryDesktopSessionStore(),
    bridge,
    planner
  });
  const started = await engine.start('Focus the target', { maxActions: 1 });
  const pending = await engine.step(started.id);
  const completed = await engine.step(started.id, { approvedFingerprint: pending.pendingAction.fingerprint });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.actionCount, 1);
  assert.equal(plannerCalls, 2);
});

test('session blocks only when another action is requested after the action budget is exhausted', async () => {
  const bridge = new FakeBridge();
  const planner = {
    async plan() {
      return {
        decision: {
          status: 'act',
          reason: 'Another focus would be required.',
          action: { action: 'window.focus', processId: 42 }
        },
        observation: { screenSha256: '0'.repeat(64), windows: 1 }
      };
    }
  };
  const engine = new DesktopTaskSessionEngine({
    store: new MemoryDesktopSessionStore(),
    bridge,
    planner
  });
  const started = await engine.start('Keep focusing until done', { maxActions: 1 });
  const pending = await engine.step(started.id);
  const blocked = await engine.step(started.id, { approvedFingerprint: pending.pendingAction.fingerprint });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.result.reason, 'desktop_session_action_budget_exhausted');
  assert.equal(blocked.actionCount, 1);
});

test('file session store persists records privately and rejects invalid ids', async () => {
  const home = await mkdtemp(join(tmpdir(), 'desktop-session-store-'));
  try {
    const store = new FileDesktopSessionStore({ home });
    const id = '123e4567-e89b-42d3-a456-426614174000';
    const session = {
      version: 1,
      id,
      goal: 'Test persistence',
      status: 'running',
      maxActions: 2,
      actionCount: 0,
      history: [],
      pendingAction: null,
      result: null,
      error: null,
      createdAt: '2026-09-23T12:00:00Z',
      updatedAt: '2026-09-23T12:00:00Z'
    };
    await store.save(session);
    assert.deepEqual(await store.load(id), session);
    await assert.rejects(store.load('../escape'), /desktop_session_id_invalid/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
