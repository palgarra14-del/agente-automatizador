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

function governedProject(id = 'callflow') {
  return configFrom({
    id,
    repository: { owner: 'palgarra14-del', name: 'App-llamadas' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version' },
    execution: { provider: 'local-sanitized' }
  });
}

function eventFor(target, {
  eventName = 'issues',
  action = eventName === 'issue_comment' ? 'created' : 'opened',
  actor = 'palgarra14-del',
  repositoryOverride = repository,
  commentBody = '/agent'
} = {}) {
  return {
    action,
    repository: {
      name: repositoryOverride.name,
      owner: { login: repositoryOverride.owner }
    },
    sender: { login: actor },
    issue: clone(target),
    ...(eventName === 'issue_comment' ? {
      comment: { body: commentBody, user: { login: actor } }
    } : {})
  };
}

function makeAdmissionQueue({
  state = { requests: {} },
  currentIssue = issue(20),
  includedProjectIds = ['callflow'],
  remoteRevision = revision
} = {}) {
  let writes = 0;
  let leases = 0;
  let openIssueCalls = 0;
  const store = {
    async load() { return clone(state); },
    async mutate(mutator) {
      writes += 1;
      return mutator(state);
    },
    async withGlobalLease(operation) {
      leases += 1;
      return operation();
    },
    async ownerIdentity() { return 'fixture-owner'; }
  };
  const channel = {
    repository,
    async issue(number) {
      return number === currentIssue.number ? clone(currentIssue) : null;
    },
    async branchHead() { return remoteRevision; },
    async openIssues() {
      openIssueCalls += 1;
      return [];
    }
  };
  const projects = new Map([['callflow', governedProject()]]);
  const queue = new SupervisedIssueQueue({
    store,
    projects,
    workflowEngine: {},
    channel,
    allowedActors: ['palgarra14-del'],
    operatorRevision: revision,
    operatorBranch: 'main',
    includedProjectIds
  });
  return { queue, state, writes: () => writes, leases: () => leases, openIssueCalls: () => openIssueCalls, channel };
}
test('event admission persists one bounded record and makes read-only cloud peek actionable', async () => {
  const target = issue(20);
  const fixture = makeAdmissionQueue({ currentIssue: target });
  const admitted = await fixture.queue.admitEvent('issues', eventFor(target));
  assert.deepEqual(admitted, { admitted: true, idempotent: false, issueNumber: 20, status: 'admitted' });
  assert.equal(fixture.writes(), 1);
  assert.equal(fixture.leases(), 1);
  assert.equal(fixture.state.requests[key(20)].status, 'admitted');
  assert.equal(fixture.state.requests[key(20)].workflowId, null);
  assert.equal(await fixture.queue.hasWork(), true);
  assert.equal(fixture.writes(), 1);
});
test('repeated event admission is idempotent and does not create another durable write', async () => {
  const target = issue(21);
  const fixture = makeAdmissionQueue({ currentIssue: target });
  await fixture.queue.admitEvent('issues', eventFor(target));
  const writesAfterFirst = fixture.writes();
  const duplicate = await fixture.queue.admitEvent('issues', eventFor(target));
  assert.equal(duplicate.admitted, false);
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.status, 'admitted');
  assert.equal(fixture.writes(), writesAfterFirst);
  assert.equal(fixture.leases(), 1);
});

test('event admission fails closed without mutation for wrong actor, repo, lane, malformed or stale payloads', async () => {
  const target = issue(22);
  const cases = [
    { name: 'actor', eventName: 'issues', event: eventFor(target, { actor: 'mallory' }), current: target, reason: 'event_actor_unauthorized' },
    { name: 'repo', eventName: 'issues', event: eventFor(target, { repositoryOverride: { owner: 'other', name: repository.name } }), current: target, reason: 'event_repository_mismatch' },
    { name: 'lane', eventName: 'issues', event: eventFor(issue(22, { projectId: 'website-pilot' })), current: issue(22, { projectId: 'website-pilot' }), reason: 'event_wrong_lane' },
    { name: 'malformed', eventName: 'issues', event: eventFor(issue(22, { body: '<!-- agent-request:v1 -->\n{"version":1' })), current: issue(22, { body: '<!-- agent-request:v1 -->\n{"version":1' }), reason: 'event_request_invalid' },
    { name: 'stale', eventName: 'issues', event: eventFor(target), current: issue(22, { body: requestBody('callflow').replace('maintenance change', 'different change') }), reason: 'event_issue_stale' }
  ];
  for (const entry of cases) {
    const fixture = makeAdmissionQueue({ currentIssue: entry.current });
    const result = await fixture.queue.admitEvent(entry.eventName, entry.event);
    assert.equal(result.admitted, false, entry.name);
    assert.equal(result.reason, entry.reason, entry.name);
    assert.equal(fixture.writes(), 0, entry.name);
    assert.equal(fixture.leases(), 0, entry.name);
    assert.deepEqual(fixture.state.requests, {}, entry.name);
  }
});

test('issue-comment admission requires an authorized exact /agent wakeup and remains model-free', async () => {
  const target = issue(23);
  const fixture = makeAdmissionQueue({ currentIssue: target });
  const admitted = await fixture.queue.admitEvent('issue_comment', eventFor(target, { eventName: 'issue_comment' }));
  assert.equal(admitted.admitted, true);
  assert.equal(fixture.state.requests[key(23)].status, 'admitted');

  const rejectedFixture = makeAdmissionQueue({ currentIssue: issue(24) });
  const rejected = await rejectedFixture.queue.admitEvent('issue_comment', eventFor(issue(24), { eventName: 'issue_comment', commentBody: '/agent-typo' }));
  assert.equal(rejected.reason, 'event_comment_invalid');
  assert.equal(rejectedFixture.writes(), 0);
  assert.equal(rejectedFixture.leases(), 0);
});

test('scheduled or manual non-issue events never mutate admission state', async () => {
  const target = issue(25);
  const fixture = makeAdmissionQueue({ currentIssue: target });
  const result = await fixture.queue.admitEvent('schedule', eventFor(target));
  assert.equal(result.reason, 'event_not_admissible');
  assert.equal(fixture.writes(), 0);
  assert.equal(fixture.leases(), 0);
});

test('tick processes an admitted record by exact issue lookup without relying on open-issue pagination', async () => {
  const target = issue(26);
  const fixture = makeAdmissionQueue({ currentIssue: target });
  await fixture.queue.admitEvent('issues', eventFor(target));
  let processed = 0;
  fixture.queue.processIssue = async (observed) => {
    processed += 1;
    assert.equal(observed.number, target.number);
    return { status: 'processed-directly' };
  };
  const result = await fixture.queue.tick();
  assert.deepEqual(result, { status: 'processed-directly' });
  assert.equal(processed, 1);
  assert.equal(fixture.openIssueCalls(), 0);
});

test('admitted request acquires initialization lease before any workflow initialization can run', async () => {
  const target = issue(27);
  const fixture = makeAdmissionQueue({ currentIssue: target });
  await fixture.queue.admitEvent('issues', eventFor(target));
  let observedSeed = null;
  fixture.queue.finishInitialization = async (_issue, _parsed, seed) => {
    observedSeed = clone(seed);
    throw new Error('fixture_stop_after_initialization_claim');
  };

  await assert.rejects(() => fixture.queue.processIssue(target), /fixture_stop_after_initialization_claim/);
  const persisted = fixture.state.requests[key(27)];
  assert.equal(persisted.status, 'initializing');
  assert.ok(persisted.initializationLease);
  assert.equal(persisted.initializationLease.ownerIdentity, 'fixture-owner');
  assert.equal(observedSeed.status, 'initializing');
  assert.equal(observedSeed.initializationLease.leaseId, persisted.initializationLease.leaseId);
  assert.equal(persisted.workflowId, null);
});

test('main drift during initialization claim restores admitted state before workflow creation', async () => {
  const target = issue(28);
  const fixture = makeAdmissionQueue({ currentIssue: target });
  await fixture.queue.admitEvent('issues', eventFor(target));
  let headCall = 0;
  fixture.channel.branchHead = async () => headCall++ === 0 ? revision : 'e'.repeat(40);
  fixture.queue.unboundPriorAgentInitialization = async () => null;
  fixture.queue.workflowEngine.create = async () => { throw new Error('unexpected_create'); };
  const result = await fixture.queue.processIssue(target);
  assert.equal(result.status, 'operator_update_pending');
  assert.equal(fixture.state.requests[key(28)].status, 'admitted');
  assert.equal(fixture.state.requests[key(28)].initializationLease, null);
});
