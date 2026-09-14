import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubStateStore, validateCloudState } from '../src/cloud-state.js';

function response(status, payload = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return payload; }
  };
}

function fakeGitHub() {
  let sequence = 10;
  const sha = () => (sequence++).toString(16).padStart(40, '0');
  const mainSha = 'a'.repeat(40);
  const mainTree = 'b'.repeat(40);
  const refs = new Map([['refs/heads/main', mainSha]]);
  const commits = new Map([[mainSha, { sha: mainSha, tree: { sha: mainTree }, parents: [] }]]);
  const trees = new Map([[mainTree, new Map()]]);
  const blobs = new Map();

  const fetchImpl = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    const prefix = '/repos/palgarra14-del/agente-automatizador';
    assert.ok(url.pathname.startsWith(prefix));
    const path = url.pathname.slice(prefix.length);
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : null;

    if (method === 'GET' && path.startsWith('/git/ref/')) {
      const ref = 'refs/' + decodeURIComponent(path.slice('/git/ref/'.length));
      const value = refs.get(ref);
      return value ? response(200, { object: { sha: value } }) : response(404, { message: 'not found' });
    }
    if (method === 'GET' && path.startsWith('/git/commits/')) {
      const value = commits.get(path.slice('/git/commits/'.length));
      return value ? response(200, value) : response(404, {});
    }
    if (method === 'GET' && path === '/contents/.agent/cloud-state.json') {
      const refName = url.searchParams.get('ref');
      const commitSha = refs.get(`refs/tags/${refName}`);
      const commit = commits.get(commitSha);
      const tree = commit && trees.get(commit.tree.sha);
      const blobSha = tree?.get('.agent/cloud-state.json');
      const content = blobSha && blobs.get(blobSha);
      return content
        ? response(200, { type: 'file', encoding: 'base64', content: Buffer.from(content).toString('base64'), sha: blobSha })
        : response(404, {});
    }
    if (method === 'POST' && path === '/git/blobs') {
      const id = sha();
      blobs.set(id, body.content);
      return response(201, { sha: id });
    }
    if (method === 'POST' && path === '/git/trees') {
      const id = sha();
      const base = new Map(trees.get(body.base_tree) ?? []);
      for (const entry of body.tree) base.set(entry.path, entry.sha);
      trees.set(id, base);
      return response(201, { sha: id });
    }
    if (method === 'POST' && path === '/git/commits') {
      const id = sha();
      commits.set(id, { sha: id, tree: { sha: body.tree }, parents: body.parents.map((parent) => ({ sha: parent })) });
      return response(201, { sha: id });
    }
    if (method === 'POST' && path === '/git/refs') {
      if (refs.has(body.ref)) return response(422, {});
      refs.set(body.ref, body.sha);
      return response(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if (method === 'PATCH' && path.startsWith('/git/refs/tags/')) {
      const ref = 'refs/tags/' + decodeURIComponent(path.slice('/git/refs/tags/'.length));
      const current = refs.get(ref);
      const candidate = commits.get(body.sha);
      if (!current || !candidate?.parents?.some((parent) => parent.sha === current) || body.force !== false) return response(422, {});
      refs.set(ref, body.sha);
      return response(200, { ref, object: { sha: body.sha } });
    }
    throw new Error(`unexpected fake GitHub request: ${method} ${path}`);
  };

  const tamperCurrentStateHash = () => {
    const commit = commits.get(refs.get('refs/tags/agent-cloud-state-v1'));
    const tree = trees.get(commit.tree.sha);
    const blobSha = tree.get('.agent/cloud-state.json');
    const envelope = JSON.parse(blobs.get(blobSha));
    envelope.stateHash = '0'.repeat(64);
    blobs.set(blobSha, JSON.stringify(envelope));
  };

  return { fetchImpl, tamperCurrentStateHash };
}

function storeFor(fake, { ownerId = 'github:1:1', now = () => Date.now(), leaseTtlMs = 60_000 } = {}) {
  return new GitHubStateStore({
    repository: { owner: 'palgarra14-del', name: 'agente-automatizador' },
    token: 'test-token-not-a-real-secret',
    fetchImpl: fake.fetchImpl,
    ownerId,
    now,
    leaseTtlMs
  });
}

test('cloud state rejects non-self ownership and secret-bearing keys without rejecting token counters', () => {
  assert.throws(() => validateCloudState({ runs: { r: { projectId: 'callflow' } }, approvals: {}, events: [] }), /ownership_mismatch/);
  assert.throws(() => validateCloudState({ runs: {}, approvals: {}, events: [], nested: { apiToken: 'value' } }), /sensitive_key/);
  assert.doesNotThrow(() => validateCloudState({
    runs: {},
    approvals: {},
    events: [],
    workflows: { w: { projectId: 'self', modelUsage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } } }
  }));
});

test('durable state bootstraps on a tag and resumes across ephemeral stores', async () => {
  const fake = fakeGitHub();
  const first = storeFor(fake, { ownerId: 'github:10:1' });
  await first.withGlobalLease(async () => {
    await first.mutate((state) => {
      state.workflows = { w1: { id: 'w1', projectId: 'self', status: 'pending', executionLease: null } };
    });
  });

  const second = storeFor(fake, { ownerId: 'github:11:1' });
  const loaded = await second.load();
  assert.equal(loaded.workflows.w1.projectId, 'self');
  assert.equal(loaded.workflows.w1.status, 'pending');
  assert.equal(loaded.cloudExecutionLease, null);
});

test('global lease excludes concurrent runners and recovers after expiry', async () => {
  const fake = fakeGitHub();
  let clock = Date.parse('2026-09-14T12:00:00Z');
  const now = () => clock;
  const first = storeFor(fake, { ownerId: 'github:20:1', now });
  const second = storeFor(fake, { ownerId: 'github:21:1', now });

  await first.claimGlobalLease();
  await assert.rejects(second.claimGlobalLease(), /cloud_global_lease_busy/);
  clock += 60_001;
  const recovered = await second.claimGlobalLease();
  assert.equal(recovered.ownerId, 'github:21:1');
  assert.equal(await second.releaseGlobalLease(recovered.leaseId), true);
});

test('optimistic ref update rejects stale writers', async () => {
  const fake = fakeGitHub();
  const first = storeFor(fake, { ownerId: 'github:30:1' });
  const seedLease = await first.claimGlobalLease();
  await first.releaseGlobalLease(seedLease.leaseId);

  const second = storeFor(fake, { ownerId: 'github:31:1' });
  const a = await first.readSnapshot();
  const b = await second.readSnapshot();
  a.state.marker = 'first';
  b.state.marker = 'second';
  await first.writeSnapshot(a.state, a);
  await assert.rejects(second.writeSnapshot(b.state, b), /cloud_state_conflict/);
});

test('execution leases use cloud owner identity and become recoverable only after ttl', async () => {
  const fake = fakeGitHub();
  let clock = Date.parse('2026-09-14T12:00:00Z');
  const now = () => clock;
  const first = storeFor(fake, { ownerId: 'github:40:1', now });
  const metadata = { ownerIdentity: 'github:old:1', createdAt: new Date(clock).toISOString() };
  assert.equal(await first.lockOwnerIsAbandoned(metadata), false);
  clock += 60_001;
  assert.equal(await first.lockOwnerIsAbandoned(metadata), true);
});

test('remote envelope integrity mismatch fails closed', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake, { ownerId: 'github:50:1' });
  const lease = await store.claimGlobalLease();
  await store.releaseGlobalLease(lease.leaseId);
  fake.tamperCurrentStateHash();
  await assert.rejects(store.load(), /cloud_state_integrity_mismatch/);
});
