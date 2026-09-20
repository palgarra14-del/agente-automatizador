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
const governedProject = () => configFrom({
  id: 'callflow', repository: { owner: 'palgarra14-del', name: 'App-llamadas' }, defaultBranch: 'main',
  protectedBranches: ['main'], workspace: '.', commands: { test: 'node --version' }, execution: { provider: 'local-sanitized' }
});
function eventFor(target, { eventName = 'issues', actor = 'palgarra14-del', repositoryOverride = repository, commentBody = '/agent' } = {}) {
  return {
    action: eventName === 'issue_comment' ? 'created' : 'opened',
    repository: { name: repositoryOverride.name, owner: { login: repositoryOverride.owner } },
    sender: { login: actor }, issue: clone(target),
    ...(eventName === 'issue_comment' ? { comment: { body: commentBody, user: { login: actor } } } : {})
  };
}
function makeAdmissionQueue({ state = { requests: {} }, currentIssue = issue(20), includedProjectIds = ['callflow'], remoteRevision = revision } = {}) {
  let writes = 0, leases = 0, openIssueCalls = 0;
  const store = {
    async load() { return clone(state); }, async mutate(mutator) { writes += 1; return mutator(state); },
    async withGlobalLease(operation) { leases += 1; return operation(); }, async ownerIdentity() { return 'fixture-owner'; }
  };
  const channel = {
    repository, async issue(number) { return number === currentIssue.number ? clone(currentIssue) : null; },
    async branchHead() { return remoteRevision; }, async openIssues() { openIssueCalls += 1; return []; }
  };
  return {
    queue: new SupervisedIssueQueue({
      store, projects: new Map([['callflow', governedProject()]]), workflowEngine: {}, channel,
      allowedActors: ['palgarra14-del'], operatorRevision: revision, operatorBranch: 'main', includedProjectIds
    }),
    state, channel, writes: () => writes, leases: () => leases, openIssueCalls: () => openIssueCalls
  };
}
test('event admission is bounded, actionable and idempotent', async () => {
  const target = issue(20), fixture = makeAdmissionQueue({ currentIssue: target });
  assert.deepEqual(await fixture.queue.admitEvent('issues', eventFor(target)), { admitted: true, idempotent: false, issueNumber: 20, status: 'admitted' });
  assert.equal(fixture.state.requests[key(20)].workflowId, null); assert.equal(await fixture.queue.hasWork(), true);
  const writes = fixture.writes(), duplicate = await fixture.queue.admitEvent('issues', eventFor(target));
  assert.equal(duplicate.idempotent, true); assert.equal(duplicate.status, 'admitted');
  assert.equal(fixture.writes(), writes); assert.equal(fixture.leases(), 1);
});
test('event admission rejects untrusted, malformed, cross-lane and stale events without writes', async () => {
  const target = issue(22), malformed = issue(22, { body: '<!-- agent-request:v1 -->\n{"version":1' });
  const cases = [
    [eventFor(target, { actor: 'mallory' }), target, 'event_actor_unauthorized'],
    [eventFor(target, { repositoryOverride: { owner: 'other', name: repository.name } }), target, 'event_repository_mismatch'],
    [eventFor(issue(22, { projectId: 'website-pilot' })), issue(22, { projectId: 'website-pilot' }), 'event_wrong_lane'],
    [eventFor(malformed), malformed, 'event_request_invalid'],
    [eventFor(target), issue(22, { body: requestBody('callflow').replace('maintenance change', 'different change') }), 'event_issue_stale']
  ];
  for (const [event, currentIssue, reason] of cases) {
    const fixture = makeAdmissionQueue({ currentIssue }), result = await fixture.queue.admitEvent('issues', event);
    assert.equal(result.reason, reason); assert.equal(fixture.writes(), 0); assert.equal(fixture.leases(), 0);
  }
});
test('comment admission requires exact /agent and non-issue wakeups stay read-only', async () => {
  const target = issue(23), fixture = makeAdmissionQueue({ currentIssue: target });
  assert.equal((await fixture.queue.admitEvent('issue_comment', eventFor(target, { eventName: 'issue_comment' }))).admitted, true);
  for (const body of ['/agent-typo', ' /agent']) {
    const rejected = makeAdmissionQueue({ currentIssue: issue(24) });
    assert.equal((await rejected.queue.admitEvent('issue_comment', eventFor(issue(24), { eventName: 'issue_comment', commentBody: body }))).reason, 'event_comment_invalid');
    assert.equal(rejected.writes(), 0);
  }
  const scheduled = makeAdmissionQueue({ currentIssue: issue(25) });
  assert.equal((await scheduled.queue.admitEvent('schedule', eventFor(issue(25)))).reason, 'event_not_admissible');
  assert.equal(scheduled.writes(), 0);
});
test('tick exact-lookups admitted work and claims its initialization lease before workflow creation', async () => {
  const target = issue(26), fixture = makeAdmissionQueue({ currentIssue: target }); await fixture.queue.admitEvent('issues', eventFor(target));
  let seed; fixture.queue.finishInitialization = async (_issue, _parsed, observed) => { seed = clone(observed); throw new Error('stop-after-claim'); };
  await assert.rejects(() => fixture.queue.tick(), /stop-after-claim/);
  const persisted = fixture.state.requests[key(26)];
  assert.equal(persisted.status, 'initializing'); assert.ok(persisted.initializationLease);
  assert.equal(seed.initializationLease.leaseId, persisted.initializationLease.leaseId);
  assert.equal(persisted.workflowId, null); assert.equal(fixture.openIssueCalls(), 0);
});
test('post-claim main drift or head-read failure restores admitted state', async () => {
  for (const mode of ['drift', 'error']) {
    const target = issue(28), fixture = makeAdmissionQueue({ currentIssue: target }); await fixture.queue.admitEvent('issues', eventFor(target));
    let calls = 0;
    fixture.channel.branchHead = async () => { if (calls++ === 0) return revision; if (mode === 'error') throw new Error('transient_head_failure'); return 'e'.repeat(40); };
    fixture.queue.workflowEngine.create = async () => { throw new Error('unexpected_create'); };
    const result = await fixture.queue.processIssue(target);
    assert.equal(result.status, mode === 'error' ? 'operator_revision_check_failed' : 'operator_update_pending');
    assert.equal(fixture.state.requests[key(28)].status, 'admitted'); assert.equal(fixture.state.requests[key(28)].initializationLease, null);
  }
});
