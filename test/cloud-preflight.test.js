import assert from 'node:assert/strict';
import test from 'node:test';
import { SupervisedIssueQueue } from '../src/issue-queue.js';
import { configFrom } from '../src/core.js';

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
  assert.equal(await own.hasWork(), false);

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

const revision = 'f'.repeat(40);
const governedProject = () => configFrom({ id: 'callflow', repository: { owner: 'palgarra14-del', name: 'App-llamadas' }, defaultBranch: 'main',
  protectedBranches: ['main'], workspace: '.', commands: { test: 'node --version' }, execution: { provider: 'local-sanitized' } });
function eventFor(target, { eventName = 'issues', actor = 'palgarra14-del', repositoryOverride = repository, commentBody = '/agent' } = {}) {
  return { action: eventName === 'issue_comment' ? 'created' : 'opened', repository: { name: repositoryOverride.name, owner: { login: repositoryOverride.owner } },
    sender: { login: actor }, issue: clone(target), ...(eventName === 'issue_comment' ? { comment: { body: commentBody, user: { login: actor } } } : {}) };
}
function admissionFixture(currentIssue = issue(20)) {
  const state = { requests: {} }; let writes = 0, leases = 0;
  const intents = new Map();
  const store = {
    async load() { return clone(state); },
    async mutate(fn) { writes += 1; return fn(state); },
    async withGlobalLease(fn) { leases += 1; return fn(); },
    async ownerIdentity() { return 'fixture-owner'; }
  };
  const channel = {
    repository,
    async issue(n) { return n === currentIssue.number ? clone(currentIssue) : null; },
    async branchHead() { return revision; },
    async openIssues() { return []; },
    async createAdmissionIntent(intent) {
      const ref = `refs/tags/agent-admission-v1/${intent.projectId}/${intent.issueNumber}/${intent.fingerprint}`;
      const created = !intents.has(ref); intents.set(ref, { ref, ...intent, targetSha: revision });
      return { created, ref };
    },
    async listAdmissionIntents(projectIds) {
      return [...intents.values()].filter((intent) => projectIds.includes(intent.projectId));
    },
    async deleteAdmissionIntent(ref) { return intents.delete(ref); }
  };
  const queue = new SupervisedIssueQueue({ store, projects: new Map([['callflow', governedProject()]]), workflowEngine: {}, channel,
    allowedActors: ['palgarra14-del'], operatorRevision: revision, operatorBranch: 'main', includedProjectIds: ['callflow'] });
  return { queue, state, channel, intents, writes: () => writes, leases: () => leases };
}
test('event admission is lease-free, retryable and idempotent until governed ingestion', async () => {
  const target = issue(20), f = admissionFixture(target);
  assert.equal((await f.queue.admitEvent('issues', eventFor(target))).admitted, true);
  assert.deepEqual(f.state.requests, {}); assert.equal(f.writes(), 0); assert.equal(f.leases(), 0); assert.equal(await f.queue.hasWork(), true);
  assert.equal((await f.queue.admitEvent('issues', eventFor(target))).idempotent, true); assert.equal(f.intents.size, 1);
  const ingested = await f.queue.ingestAdmissionIntents();
  assert.equal(ingested.status, 'admitted'); assert.equal(f.state.requests[key(20)].status, 'admitted'); assert.equal(f.intents.size, 0);

  const retry = admissionFixture(issue(21)); retry.channel.issue = async () => { throw new Error('transient issue read'); };
  const result = await retry.queue.admitEvent('issues', eventFor(issue(21)));
  assert.equal(result.retryable, true); assert.equal(retry.intents.size, 1); assert.deepEqual(retry.state.requests, {});
});
test('ingestion rejects an intent tag whose target sha is not the trusted operator revision', async () => {
  const target = issue(37), f = admissionFixture(target);
  await f.queue.admitEvent('issues', eventFor(target));
  const [ref, intent] = [...f.intents.entries()][0];
  f.intents.set(ref, { ...intent, targetSha: 'e'.repeat(40) });
  f.channel.listAdmissionIntents = async () => [...f.intents.values()];

  const result = await f.queue.ingestAdmissionIntents();
  assert.equal(result, null);
  assert.deepEqual(f.state.requests, {});
  assert.equal(f.intents.size, 0);
});

test('scheduled recovery recreates a missing intent for valid unpersisted work only', async () => {
  const target = issue(38), f = admissionFixture(target);
  f.channel.openIssues = async () => [clone(target)];
  f.channel.listAdmissionIntents = async () => [...f.intents.values()];
  const recovered = await f.queue.recoverAdmissionIntents();

  assert.equal(recovered.scanned, 1);
  assert.equal(recovered.created, 1);
  assert.equal(f.intents.size, 1);
  assert.deepEqual(f.state.requests, {});
  assert.equal(await f.queue.hasWork(), true);

  const ingested = await f.queue.ingestAdmissionIntents();
  assert.equal(ingested.status, 'admitted');
  assert.equal(f.state.requests[key(38)].status, 'admitted');

  const afterCanonical = await f.queue.recoverAdmissionIntents();
  assert.equal(afterCanonical.created, 0);
  assert.equal(afterCanonical.existing, 1);
});

test('admission intent ingestion is crash-safe after canonical persistence', async () => {
  const target = issue(27), f = admissionFixture(target);
  await f.queue.admitEvent('issues', eventFor(target));
  const originalDelete = f.channel.deleteAdmissionIntent;
  let deleteCalls = 0;
  f.channel.deleteAdmissionIntent = async (ref) => {
    deleteCalls += 1;
    if (deleteCalls === 1) throw new Error('intent_delete_transport_failed');
    return originalDelete(ref);
  };

  await assert.rejects(() => f.queue.ingestAdmissionIntents(), /intent_delete_transport_failed/);
  assert.equal(f.state.requests[key(27)].status, 'admitted');
  assert.equal(f.intents.size, 1);

  const retried = await f.queue.ingestAdmissionIntents();
  assert.equal(retried, null);
  assert.equal(Object.keys(f.state.requests).length, 1);
  assert.equal(f.state.requests[key(27)].status, 'admitted');
  assert.equal(f.intents.size, 0);
});

test('stale edited or closed intent is retired without canonical admission', async () => {
  for (const mode of ['edited', 'closed']) {
    const target = issue(28), f = admissionFixture(target);
    await f.queue.admitEvent('issues', eventFor(target));
    const changed = mode === 'edited'
      ? issue(28, { body: requestBody().replace('deterministic maintenance change', 'different governed change') })
      : { ...target, state: 'closed' };
    f.channel.issue = async () => clone(changed);

    const result = await f.queue.ingestAdmissionIntents();
    assert.equal(result, null);
    assert.deepEqual(f.state.requests, {});
    assert.equal(f.intents.size, 0);
  }
});

test('transient intent revalidation failure keeps the durable intent for recovery', async () => {
  const target = issue(29), f = admissionFixture(target);
  await f.queue.admitEvent('issues', eventFor(target));
  f.channel.issue = async () => { throw new Error('transient_issue_read'); };

  await assert.rejects(() => f.queue.ingestAdmissionIntents(), /admission_intent_issue_read_failed/);
  assert.deepEqual(f.state.requests, {});
  assert.equal(f.intents.size, 1);
});

test('event admission rejects untrusted, malformed, cross-lane and proven-stale events without state or intents', async () => {
  const target = issue(22), malformed = issue(22, { body: '<!-- agent-request:v1 -->\n{"version":1' });
  const cases = [[eventFor(target, { actor: 'mallory' }), target, 'event_actor_unauthorized'], [eventFor(malformed), malformed, 'event_request_invalid'],
    [eventFor(issue(22, { projectId: 'website-pilot' })), issue(22, { projectId: 'website-pilot' }), 'event_wrong_lane'],
    [eventFor(target), issue(22, { body: requestBody().replace('maintenance change', 'different change') }), 'event_issue_stale']];
  for (const [event, currentIssue, reason] of cases) {
    const f = admissionFixture(currentIssue), result = await f.queue.admitEvent('issues', event);
    assert.equal(result.reason, reason); assert.equal(f.writes(), 0); assert.equal(f.intents.size, 0);
  }
});
test('comment admission trims exact /agent but rejects non-admission wakeups', async () => {
  for (const body of ['/agent', ' /agent', '/agent\n']) {
    const target = issue(23), f = admissionFixture(target);
    assert.equal((await f.queue.admitEvent('issue_comment', eventFor(target, { eventName: 'issue_comment', commentBody: body }))).admitted, true);
    assert.equal(f.intents.size, 1); assert.equal(f.writes(), 0);
  }
  for (const body of ['/agent-typo', '/agent approve token']) {
    const target = issue(24), f = admissionFixture(target);
    assert.equal((await f.queue.admitEvent('issue_comment', eventFor(target, { eventName: 'issue_comment', commentBody: body }))).reason, 'event_comment_invalid');
    assert.equal(f.intents.size, 0); assert.equal(f.writes(), 0);
  }
});

test('admitted work claims a lease and trusted-main drift restores it before creation', async () => {
  for (const mode of ['claim', 'drift']) {
    const target = issue(26), f = admissionFixture(target); await f.queue.admitEvent('issues', eventFor(target)); await f.queue.ingestAdmissionIntents(); f.queue.unboundPriorAgentInitialization = async () => null;
    if (mode === 'claim') f.queue.finishInitialization = async (_i, _p, record) => { assert.ok(record.initializationLease); throw new Error('stop-after-claim'); };
    else { let calls = 0; f.channel.branchHead = async () => calls++ === 0 ? revision : 'e'.repeat(40); f.queue.workflowEngine.create = async () => { throw new Error('unexpected_create'); }; }
    if (mode === 'claim') await assert.rejects(() => f.queue.tick(), /stop-after-claim/); else assert.equal((await f.queue.processIssue(target)).status, 'operator_update_pending');
    assert.equal(f.state.requests[key(26)].status, mode === 'claim' ? 'initializing' : 'admitted');
  }
});
