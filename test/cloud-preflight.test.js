import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
function admissionFixture(currentIssue = issue(20), { includedProjectIds = ['callflow'], projects = new Map([['callflow', governedProject()]]) } = {}) {
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
    admissionIntentRef(intent) {
      return `refs/tags/agent-admission-v1/${intent.projectId}/${intent.issueNumber}/${intent.fingerprint}`;
    },
    async createAdmissionIntent(intent, targetSha = revision) {
      const ref = this.admissionIntentRef(intent);
      const existing = intents.get(ref);
      if (existing && existing.targetSha !== targetSha) throw new Error('admission_intent_existing_conflict');
      const created = !existing;
      intents.set(ref, { ref, ...intent, targetSha });
      return { created, ref };
    },
    async admissionIntentTarget(ref) { return intents.get(ref)?.targetSha ?? null; },
    async listAdmissionIntents(projectIds) {
      return [...intents.values()].filter((intent) => projectIds.includes(intent.projectId));
    },
    async deleteAdmissionIntent(ref) { return intents.delete(ref); }
  };
  const queue = new SupervisedIssueQueue({ store, projects, workflowEngine: {}, channel,
    allowedActors: ['palgarra14-del'], operatorRevision: revision, operatorBranch: 'main', includedProjectIds });
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
test('authorized malformed requests are durably rejected only by the self lane', async () => {
  const malformed = issue(42, { body: '<!-- agent-request:v1 -->\n{"version":1,"projectId":"callflow"' });

  const foreignLane = admissionFixture(malformed);
  const foreignResult = await foreignLane.queue.admitEvent('issues', eventFor(malformed));
  assert.equal(foreignResult.admitted, false);
  assert.equal(foreignResult.reason, 'event_request_invalid');
  assert.equal(foreignLane.intents.size, 0);
  assert.deepEqual(foreignLane.state.requests, {});

  const selfLane = admissionFixture(malformed, { includedProjectIds: ['self'] });
  const eventResult = await selfLane.queue.admitEvent('issues', eventFor(malformed));
  assert.equal(eventResult.admitted, true);
  assert.equal(eventResult.malformed, true);
  assert.equal(selfLane.intents.size, 1);
  assert.equal(selfLane.writes(), 0);
  assert.equal(selfLane.leases(), 0);

  const rejected = await selfLane.queue.ingestAdmissionIntents();
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason, 'malformed_request');
  assert.equal(rejected.request, null);
  assert.equal(rejected.routingProjectId, 'self');
  assert.equal(rejected.workflowId, null);
  assert.equal(rejected.terminalNotification.sentAt, null);
  assert.equal(selfLane.intents.size, 0);
  assert.equal(selfLane.state.requests[key(42)].status, 'rejected');
  assert.equal(await selfLane.queue.hasWork(), true);

  selfLane.channel.comments = async () => [];
  selfLane.channel.comment = async (_number, body) => {
    assert.match(body, /request body is malformed/);
    assert.match(body, /No workflow, model call, project write/);
    return { id: 4200 };
  };
  const notified = await selfLane.queue.tick();
  assert.equal(notified.status, 'rejected');
  assert.equal(notified.terminalNotification.commentId, 4200);
  assert.ok(notified.terminalNotification.sentAt);
  assert.equal(await selfLane.queue.hasWork(), false);
});

test('a corrected valid self request supersedes only its malformed terminal tombstone', async () => {
  const malformed = issue(44, { body: '<!-- agent-request:v1 -->\n{"version":1' });
  const selfProject = configFrom({
    id: 'self',
    repository: { owner: 'palgarra14-del', name: 'agente-automatizador' },
    defaultBranch: 'main',
    protectedBranches: ['main'],
    workspace: '.',
    commands: { test: 'node --version' },
    execution: { provider: 'local-sanitized' }
  });
  const f = admissionFixture(malformed, {
    includedProjectIds: ['self'],
    projects: new Map([['self', selfProject]])
  });

  await f.queue.admitEvent('issues', eventFor(malformed));
  const tombstone = await f.queue.ingestAdmissionIntents();
  assert.equal(tombstone.status, 'rejected');
  assert.equal(tombstone.reason, 'malformed_request');

  const corrected = issue(44, { projectId: 'self', body: requestBody('self') });
  f.channel.issue = async () => clone(corrected);
  f.channel.openIssues = async () => [clone(corrected)];

  const eventResult = await f.queue.admitEvent('issues', eventFor(corrected));
  assert.equal(eventResult.admitted, true);
  const admitted = await f.queue.ingestAdmissionIntents();
  assert.equal(admitted.status, 'admitted');
  assert.equal(admitted.request.projectId, 'self');
  assert.equal(admitted.reason, null);
  assert.equal(admitted.workflowId, null);
  assert.equal(f.state.requests[key(44)].status, 'admitted');

  const recovered = await f.queue.recoverAdmissionIntents();
  assert.equal(recovered.created, 0);
  assert.equal(recovered.existing, 1);
});

test('scheduled recovery rediscovers an authorized malformed request for the self lane', async () => {
  const malformed = issue(43, { body: '<!-- agent-request:v1 -->\n{"version":1' });
  const selfLane = admissionFixture(malformed, { includedProjectIds: ['self'] });
  selfLane.channel.openIssues = async () => [clone(malformed)];
  selfLane.channel.listAdmissionIntents = async (projectIds) =>
    [...selfLane.intents.values()].filter((intent) => projectIds.includes(intent.projectId));

  const recovered = await selfLane.queue.recoverAdmissionIntents();
  assert.equal(recovered.created, 1);
  assert.equal(recovered.scanned, 1);
  assert.deepEqual(selfLane.state.requests, {});
  assert.equal(selfLane.intents.size, 1);
  assert.equal([...selfLane.intents.values()][0].projectId, 'self');
  assert.equal(await selfLane.queue.hasWork(), true);
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

test('scheduled recovery retires a stale-target intent before recreating it at the trusted revision', async () => {
  const target = issue(39), f = admissionFixture(target);
  f.channel.openIssues = async () => [clone(target)];
  const staleRef = `refs/tags/agent-admission-v1/callflow/39/${'a'.repeat(64)}`;
  f.intents.set(staleRef, {
    ref: staleRef,
    projectId: 'callflow',
    issueNumber: 39,
    fingerprint: 'a'.repeat(64),
    targetSha: 'e'.repeat(40)
  });
  f.channel.listAdmissionIntents = async () => [...f.intents.values()];
  f.channel.createAdmissionIntent = async (intent, targetSha) => {
    const ref = `refs/tags/agent-admission-v1/${intent.projectId}/${intent.issueNumber}/${intent.fingerprint}`;
    const existing = f.intents.get(ref);
    if (existing && existing.targetSha !== targetSha) throw new Error('admission_intent_existing_conflict');
    const created = !existing;
    f.intents.set(ref, { ref, ...intent, targetSha });
    return { created, ref };
  };

  const recovered = await f.queue.recoverAdmissionIntents();
  assert.equal(recovered.staleRetired, 1);
  assert.equal(recovered.created, 1);
  assert.equal(f.intents.size, 1);
  assert.equal([...f.intents.values()][0].targetSha, revision);
});

test('scheduled recovery cannot starve new work behind more than fifty canonical open issues', async () => {
  const fresh = issue(99), f = admissionFixture(fresh);
  const historical = Array.from({ length: 60 }, (_, index) => issue(index + 1));
  for (const oldIssue of historical) {
    f.state.requests[key(oldIssue.number)] = {
      status: 'completed',
      request: { projectId: 'callflow' }
    };
  }
  f.channel.openIssues = async () => [...historical.map(clone), clone(fresh)];
  f.channel.listAdmissionIntents = async () => [...f.intents.values()];

  const recovered = await f.queue.recoverAdmissionIntents({ max: 50 });
  assert.equal(recovered.existing, 60);
  assert.equal(recovered.scanned, 1);
  assert.equal(recovered.created, 1);
  assert.equal(f.intents.size, 1);
  assert.equal([...f.intents.values()][0].issueNumber, 99);
});

test('scheduled recovery paginates beyond five full issue pages to reach lost work', async () => {
  const fresh = issue(601), f = admissionFixture(fresh);
  for (let number = 1; number <= 500; number += 1) {
    f.state.requests[key(number)] = {
      status: 'completed',
      request: { projectId: 'callflow' }
    };
  }
  f.channel.listAdmissionIntents = async () => [...f.intents.values()];
  f.channel.openIssuePage = async (page) => {
    if (page <= 5) {
      const start = (page - 1) * 100 + 1;
      return {
        issues: Array.from({ length: 100 }, (_, index) => issue(start + index)),
        hasMore: true
      };
    }
    if (page === 6) return { issues: [clone(fresh)], hasMore: false };
    throw new Error('unexpected_page');
  };

  const recovered = await f.queue.recoverAdmissionIntents({ max: 50, maxPages: 20 });
  assert.equal(recovered.pages, 6);
  assert.equal(recovered.existing, 500);
  assert.equal(recovered.scanned, 1);
  assert.equal(recovered.created, 1);
  assert.equal(recovered.truncated, false);
  assert.equal([...f.intents.values()][0].issueNumber, 601);
});

test('scheduled recovery advances a durable page cursor across capped runs', async () => {
  const fresh = issue(2101), f = admissionFixture(fresh);
  for (let number = 1; number <= 2000; number += 1) {
    f.state.requests[key(number)] = { status: 'completed', request: { projectId: 'callflow' } };
  }
  let cursorPage = 1;
  f.channel.listAdmissionIntents = async () => [];
  f.channel.admissionRecoveryCursor = async () => ({ page: cursorPage });
  f.channel.setAdmissionRecoveryCursor = async (_scopeKey, page) => {
    cursorPage = page;
    return { page };
  };
  f.channel.openIssuePage = async (page) => {
    if (page <= 20) {
      const start = (page - 1) * 100 + 1;
      return {
        issues: Array.from({ length: 100 }, (_, index) => issue(start + index)),
        hasMore: true
      };
    }
    if (page === 21) return { issues: [clone(fresh)], hasMore: false };
    throw new Error('unexpected_page');
  };

  const first = await f.queue.recoverAdmissionIntents({ max: 50, maxPages: 20 });
  assert.equal(first.truncated, true);
  assert.equal(first.pages, 20);
  assert.equal(first.created, 0);
  assert.equal(cursorPage, 21);

  const second = await f.queue.recoverAdmissionIntents({ max: 50, maxPages: 20 });
  assert.equal(second.truncated, false);
  assert.equal(second.pages, 1);
  assert.equal(second.created, 1);
  assert.equal(cursorPage, 1);
  assert.equal([...f.intents.values()][0].issueNumber, 2101);
});

test('scheduled recovery rebinds the existing cursor page when trusted revision changes', async () => {
  const fresh = issue(2101), f = admissionFixture(fresh);
  const setCalls = [];
  f.channel.listAdmissionIntents = async () => [];
  f.channel.admissionRecoveryCursor = async () => ({ page: 21, needsRebind: true });
  f.channel.setAdmissionRecoveryCursor = async (_scopeKey, page, targetSha) => {
    setCalls.push({ page, targetSha });
    return { page };
  };
  f.channel.openIssuePage = async (page) => {
    assert.equal(page, 21);
    return { issues: [clone(fresh)], hasMore: false };
  };

  const recovered = await f.queue.recoverAdmissionIntents({ max: 50, maxPages: 20 });
  assert.equal(recovered.created, 1);
  assert.equal(recovered.pages, 1);
  assert.equal(recovered.truncated, false);
  assert.deepEqual(setCalls, [
    { page: 21, targetSha: revision },
    { page: 1, targetSha: revision }
  ]);
  assert.equal([...f.intents.values()][0].issueNumber, 2101);
});

test('scheduled recovery repairs an exact stale ref even when listing does not expose it', async () => {
  const target = issue(41), f = admissionFixture(target);
  await f.queue.admitEvent('issues', eventFor(target));
  const [ref, existing] = [...f.intents.entries()][0];
  f.intents.set(ref, { ...existing, targetSha: 'e'.repeat(40) });

  f.channel.listAdmissionIntents = async () => [];
  f.channel.openIssues = async () => [clone(target)];

  const recovered = await f.queue.recoverAdmissionIntents();
  assert.equal(recovered.created, 1);
  assert.equal(f.intents.size, 1);
  assert.equal(f.intents.get(ref).targetSha, revision);
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

test('definitive missing issue retires its intent instead of wedging the lane', async () => {
  const target = issue(40), f = admissionFixture(target);
  await f.queue.admitEvent('issues', eventFor(target));
  f.channel.issue = async () => { throw new Error('GitHub issue queue request failed: 404'); };

  const result = await f.queue.ingestAdmissionIntents();
  assert.equal(result, null);
  assert.deepEqual(f.state.requests, {});
  assert.equal(f.intents.size, 0);
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

test('cloud drain advances repeatedly then stops when the lane becomes idle', async () => {
  const f = admissionFixture(issue(30));
  let ticks = 0;
  f.queue.ingestAdmissionIntents = async () => null;
  f.queue.hasWork = async () => ticks < 3;
  f.queue.tick = async () => {
    ticks += 1;
    f.state.drainProgress = ticks;
    return { status: 'running', issueNumber: 30 };
  };

  const result = await f.queue.drain({ maxTicks: 6, maxRuntimeMs: 30 * 60 * 1000, clock: () => 0 });
  assert.equal(result.status, 'drained');
  assert.equal(result.ticks, 3);
  assert.equal(ticks, 3);
});

test('cloud drain stops on no progress, human wait, terminal state, max ticks and deadline', async () => {
  const noProgress = admissionFixture(issue(31));
  noProgress.queue.ingestAdmissionIntents = async () => null;
  noProgress.queue.hasWork = async () => true;
  noProgress.queue.tick = async () => ({ status: 'running', issueNumber: 31 });
  const noProgressResult = await noProgress.queue.drain({ maxTicks: 4, maxRuntimeMs: 30 * 60 * 1000, clock: () => 0 });
  assert.equal(noProgressResult.status, 'no_progress');
  assert.equal(noProgressResult.ticks, 1);

  const human = admissionFixture(issue(32));
  human.queue.ingestAdmissionIntents = async () => null;
  human.queue.hasWork = async () => true;
  human.queue.tick = async () => {
    human.state.humanWait = true;
    return { status: 'awaiting_start_approval', issueNumber: 32, pendingApproval: { kind: 'start' } };
  };
  const humanResult = await human.queue.drain({ clock: () => 0 });
  assert.equal(humanResult.status, 'awaiting_human');
  assert.equal(humanResult.ticks, 1);

  const terminal = admissionFixture(issue(33));
  terminal.queue.ingestAdmissionIntents = async () => null;
  terminal.queue.hasWork = async () => true;
  terminal.queue.tick = async () => {
    terminal.state.cancelled = true;
    return { status: 'rejected', issueNumber: 33 };
  };
  const terminalResult = await terminal.queue.drain({ clock: () => 0 });
  assert.equal(terminalResult.status, 'terminal');
  assert.equal(terminalResult.ticks, 1);

  const bounded = admissionFixture(issue(34));
  let boundedTicks = 0;
  bounded.queue.ingestAdmissionIntents = async () => null;
  bounded.queue.hasWork = async () => true;
  bounded.queue.tick = async () => {
    boundedTicks += 1;
    bounded.state.progress = boundedTicks;
    return { status: 'running', issueNumber: 34 };
  };
  const boundedResult = await bounded.queue.drain({ maxTicks: 2, maxRuntimeMs: 30 * 60 * 1000, clock: () => 0 });
  assert.equal(boundedResult.status, 'max_ticks');
  assert.equal(boundedResult.ticks, 2);

  const deadlineProject = governedProject();
  deadlineProject.budgets.maxRuntimeMinutes = 20;
  const deadline = admissionFixture(issue(35), { projects: new Map([['callflow', deadlineProject]]) });
  let now = 0;
  deadline.queue.ingestAdmissionIntents = async () => null;
  deadline.queue.hasWork = async () => true;
  deadline.queue.tick = async () => {
    deadline.state.progress = 1;
    now = 10 * 60 * 1000;
    return { status: 'running', issueNumber: 35 };
  };
  const deadlineResult = await deadline.queue.drain({
    maxTicks: 4,
    maxRuntimeMs: 30 * 60 * 1000,
    exitMarginMs: 60_000,
    clock: () => now
  });
  assert.equal(deadlineResult.status, 'deadline');
  assert.equal(deadlineResult.ticks, 1);

  let unsafeTickCalls = 0;
  const insufficient = admissionFixture(issue(36), { projects: new Map([['callflow', deadlineProject]]) });
  insufficient.queue.ingestAdmissionIntents = async () => null;
  insufficient.queue.hasWork = async () => true;
  insufficient.queue.tick = async () => { unsafeTickCalls += 1; return { status: 'running' }; };
  const insufficientResult = await insufficient.queue.drain({
    maxRuntimeMs: 20 * 60 * 1000,
    exitMarginMs: 60_000,
    clock: () => 0
  });
  assert.equal(insufficientResult.status, 'deadline');
  assert.equal(insufficientResult.ticks, 0);
  assert.equal(unsafeTickCalls, 0);

  let preflightNow = 0;
  let lateTickCalls = 0;
  const late = admissionFixture(issue(45), { projects: new Map([['callflow', deadlineProject]]) });
  late.queue.ingestAdmissionIntents = async () => { preflightNow = 10 * 60 * 1000; };
  late.queue.hasWork = async () => true;
  late.queue.tick = async () => { lateTickCalls += 1; return { status: 'running' }; };
  const lateResult = await late.queue.drain({
    maxRuntimeMs: 30 * 60 * 1000,
    exitMarginMs: 60_000,
    clock: () => preflightNow
  });
  assert.equal(lateResult.status, 'deadline');
  assert.equal(lateResult.ticks, 0);
  assert.equal(lateTickCalls, 0);

  let loadNow = 0;
  let postLoadTickCalls = 0;
  const slowLoad = admissionFixture(issue(47), { projects: new Map([['callflow', deadlineProject]]) });
  slowLoad.queue.ingestAdmissionIntents = async () => null;
  slowLoad.queue.hasWork = async () => true;
  const originalLoad = slowLoad.queue.store.load.bind(slowLoad.queue.store);
  let loadCalls = 0;
  slowLoad.queue.store.load = async () => {
    const snapshot = await originalLoad();
    loadCalls += 1;
    if (loadCalls === 1) loadNow = 10 * 60 * 1000;
    return snapshot;
  };
  slowLoad.queue.tick = async () => {
    postLoadTickCalls += 1;
    return { status: 'running', issueNumber: 47 };
  };
  const slowLoadResult = await slowLoad.queue.drain({
    maxRuntimeMs: 30 * 60 * 1000,
    exitMarginMs: 60_000,
    clock: () => loadNow
  });
  assert.equal(slowLoadResult.status, 'deadline');
  assert.equal(slowLoadResult.ticks, 0);
  assert.equal(postLoadTickCalls, 0);
});

test('drain tick reuses the checked state snapshot without a second pre-work state load', async () => {
  const f = admissionFixture(issue(48));
  const snapshot = clone(f.state);
  let unexpectedLoads = 0;
  f.queue.store.load = async () => {
    unexpectedLoads += 1;
    throw new Error('unexpected_store_load');
  };

  const result = await f.queue.tick({ stateSnapshot: snapshot });
  assert.equal(result, null);
  assert.equal(unexpectedLoads, 0);
  await assert.rejects(() => f.queue.tick({ stateSnapshot: [] }), /issue_queue_tick_state_snapshot_invalid/);
});

test('cloud drain rechecks its absolute budget at the real execution boundary', async () => {
  const target = issue(50);
  const project = governedProject();
  project.budgets.maxRuntimeMinutes = 20;
  const f = admissionFixture(target, { projects: new Map([['callflow', project]]) });
  let now = 0;
  let realExecutions = 0;
  f.queue.ingestAdmissionIntents = async () => null;
  f.queue.hasWork = async () => true;
  f.queue.tick = async ({ executionGuard } = {}) => {
    now = 10 * 60 * 1000;
    const blocked = f.queue.drainExecutionDeadline(target, executionGuard);
    if (blocked) return blocked;
    realExecutions += 1;
    return { status: 'running', issueNumber: 50 };
  };

  const result = await f.queue.drain({
    maxRuntimeMs: 30 * 60 * 1000,
    exitMarginMs: 60_000,
    clock: () => now
  });
  assert.equal(result.status, 'deadline');
  assert.equal(result.ticks, 0);
  assert.equal(result.last.status, 'drain_deadline');
  assert.equal(realExecutions, 0);

  const guard = {
    deadlineAtMs: 30 * 60 * 1000,
    requiredRuntimeMs: 20 * 60 * 1000,
    exitMarginMs: 60_000,
    clock: () => now
  };
  now = 9 * 60 * 1000;
  assert.equal(f.queue.drainExecutionDeadline(target, guard), null);
  now += 1;
  assert.equal(f.queue.drainExecutionDeadline(target, guard).status, 'drain_deadline');
});

test('drain active-request path reuses the checked record snapshot without reloading state', async () => {
  const target = issue(49);
  const record = {
    status: 'admitted',
    request: { projectId: 'callflow' },
    issueNumber: target.number,
    issueId: target.id,
    author: target.user.login
  };

  const tickFixture = admissionFixture(target);
  const snapshot = clone(tickFixture.state);
  snapshot.requests[key(49)] = clone(record);
  let seenRecord = null;
  tickFixture.queue.processIssue = async (_issue, { recordSnapshot } = {}) => {
    seenRecord = recordSnapshot;
    return { status: 'running', issueNumber: 49 };
  };
  const result = await tickFixture.queue.tick({ stateSnapshot: snapshot });
  assert.equal(result.status, 'running');
  assert.deepEqual(seenRecord, record);

  const processFixture = admissionFixture(target);
  let unexpectedLoads = 0;
  processFixture.queue.store.load = async () => {
    unexpectedLoads += 1;
    throw new Error('unexpected_store_load');
  };
  processFixture.queue.processExisting = async (_issue, _parsed, existing) => {
    assert.deepEqual(existing, record);
    return { status: 'running', issueNumber: 49 };
  };
  const processed = await processFixture.queue.processIssue(target, { recordSnapshot: record });
  assert.equal(processed.status, 'running');
  assert.equal(unexpectedLoads, 0);
  await assert.rejects(
    () => processFixture.queue.processIssue(target, { recordSnapshot: [] }),
    /issue_queue_process_record_snapshot_invalid/
  );
});

test('cloud drain workflow options propagate only an absolute execution cap', () => {
  const f = admissionFixture(issue(51));
  const guard = {
    deadlineAtMs: 30 * 60 * 1000,
    requiredRuntimeMs: 20 * 60 * 1000,
    exitMarginMs: 60_000,
    clock: () => 0
  };

  assert.deepEqual(
    f.queue.workflowExecutionOptions(guard, { refreshPristineDeadline: true }),
    { refreshPristineDeadline: true, deadlineCapAt: 29 * 60 * 1000 }
  );
  assert.deepEqual(
    f.queue.workflowExecutionOptions(guard),
    { deadlineCapAt: 29 * 60 * 1000 }
  );
  assert.deepEqual(
    f.queue.workflowExecutionOptions(null, { refreshPristineDeadline: true }),
    { refreshPristineDeadline: true }
  );
  assert.throws(
    () => f.queue.workflowExecutionOptions({ ...guard, deadlineAtMs: 30_000, exitMarginMs: 60_000 }),
    /issue_queue_drain_execution_guard_invalid/
  );
});

test('cloud drain propagates its deadline cap to every durable workflow read in processExisting', () => {
  const source = readFileSync(new URL('../src/issue-queue.js', import.meta.url), 'utf8');
  const start = source.indexOf('  async processExisting(');
  const end = source.indexOf('\n  async processIssue(', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  assert.equal((body.match(/workflowEngine\.get\(record\.workflowId\)/g) ?? []).length, 0);
  assert.equal(
    (body.match(/workflowEngine\.get\(record\.workflowId, this\.workflowExecutionOptions\(executionGuard\)\)/g) ?? []).length,
    4
  );
});

test('cloud drain processes a pending terminal notification once and stops', async () => {
  const f = admissionFixture(issue(46));
  f.state.requests[key(46)] = {
    status: 'completed',
    request: { projectId: 'callflow' },
    terminalNotification: { sentAt: null }
  };
  let ticks = 0;
  f.queue.ingestAdmissionIntents = async () => null;
  f.queue.hasWork = async () => ticks === 0;
  f.queue.tick = async () => {
    ticks += 1;
    f.state.requests[key(46)].terminalNotification.sentAt = '2026-09-21T00:00:00.000Z';
    return { status: 'completed', issueNumber: 46, terminalNotification: f.state.requests[key(46)].terminalNotification };
  };
  const result = await f.queue.drain({ clock: () => 0 });
  assert.equal(result.status, 'terminal');
  assert.equal(result.ticks, 1);
  assert.equal(ticks, 1);
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
