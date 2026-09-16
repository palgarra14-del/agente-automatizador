import assert from 'node:assert/strict';
import test from 'node:test';
import { SupervisedIssueQueue } from '../src/issue-queue.js';

const repository = { owner: 'palgarra14-del', name: 'agente-automatizador' };
const key = (number) => `${repository.owner}/${repository.name}#${number}`;
const clone = (value) => JSON.parse(JSON.stringify(value));

function requestBody(projectId = 'callflow') {
  return `<!-- agent-request:v1 -->
${JSON.stringify({
    version: 1,
    projectId,
    profile: 'app-improvement',
    goal: 'Apply one bounded deterministic maintenance change',
    scope: { allowedPaths: ['src'] }
  })}`;
}

function issue(number, { projectId = 'callflow', body = requestBody(projectId), author = 'palgarra14-del' } = {}) {
  return {
    number,
    id: `issue-${number}`,
    state: 'open',
    pull_request: null,
    body,
    user: { login: author }
  };
}

function makeQueue({ state = { requests: {} }, issues = [], includedProjectIds = ['callflow'] } = {}) {
  const store = {
    async load() { return clone(state); },
    async mutate() { throw new Error('cloud preflight must remain read-only'); }
  };
  const channel = {
    repository,
    async openIssues() { return clone(issues); }
  };
  return new SupervisedIssueQueue({
    store,
    projects: new Map(),
    workflowEngine: {},
    channel,
    allowedActors: ['palgarra14-del'],
    includedProjectIds
  });
}

test('cloud preflight is idle when the lane has no governed work', async () => {
  const queue = makeQueue();
  assert.equal(await queue.hasWork(), false);
});

test('cloud preflight routes new requests to exactly their owned lane', async () => {
  const own = makeQueue({ issues: [issue(1, { projectId: 'callflow' })] });
  assert.equal(await own.hasWork(), true);

  const foreign = makeQueue({ issues: [issue(2, { projectId: 'website-pilot' })] });
  assert.equal(await foreign.hasWork(), false);
});

test('cloud preflight ignores unauthorized new requests in an owned lane', async () => {
  const queue = makeQueue({
    issues: [issue(6, { projectId: 'callflow', author: 'untrusted-user' })]
  });
  assert.equal(await queue.hasWork(), false);
});

test('cloud preflight keeps active lane state actionable without mutating it', async () => {
  const state = {
    requests: {
      [key(3)]: {
        status: 'running',
        request: { projectId: 'callflow' }
      }
    }
  };
  const queue = makeQueue({ state });
  assert.equal(await queue.hasWork(), true);
});

test('cloud preflight wakes for unsent terminal notifications and sleeps after delivery', async () => {
  const unsent = makeQueue({
    state: {
      requests: {
        [key(4)]: {
          status: 'failed',
          request: { projectId: 'callflow' },
          terminalNotification: { sentAt: null }
        }
      }
    }
  });
  assert.equal(await unsent.hasWork(), true);

  const sent = makeQueue({
    state: {
      requests: {
        [key(4)]: {
          status: 'failed',
          request: { projectId: 'callflow' },
          terminalNotification: { sentAt: '2026-09-16T10:00:00.000Z' }
        }
      }
    }
  });
  assert.equal(await sent.hasWork(), false);
});

test('cloud preflight fails closed on malformed new requests instead of starting heavy runtime', async () => {
  const queue = makeQueue({
    issues: [issue(5, { body: '<!-- agent-request:v1 -->\n{"version":1,"projectId":"callflow"' })]
  });
  assert.equal(await queue.hasWork(), false);
});
