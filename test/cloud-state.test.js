import assert from 'node:assert/strict';
import test from 'node:test';
import { URL } from 'node:url';
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
  const contentRefs = [];
  const failures = [];
  let lastCreatedCommit = null;

  const isAncestor = (ancestorSha, descendantSha) => {
    if (ancestorSha === descendantSha) return true;
    const stack = [descendantSha];
    const seen = new Set();
    while (stack.length) {
      const current = stack.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = commits.get(current);
      for (const parent of commit?.parents ?? []) {
        if (parent.sha === ancestorSha) return true;
        stack.push(parent.sha);
      }
    }
    return false;
  };

  const maybeFail = (method, path, body) => {
    const index = failures.findIndex((failure) => failure.method === method && failure.match(path, body));
    if (index === -1) return null;
    const [failure] = failures.splice(index, 1);
    return response(failure.status, { message: 'injected failure' });
  };

  const fetchImpl = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    const prefix = '/repos/palgarra14-del/agente-automatizador';
    assert.ok(url.pathname.startsWith(prefix));
    const path = url.pathname.slice(prefix.length);
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    const injected = maybeFail(method, path, body);
    if (injected) return injected;

    if (method === 'GET' && path.startsWith('/git/ref/')) {
      const ref = 'refs/' + decodeURIComponent(path.slice('/git/ref/'.length));
      const value = refs.get(ref);
      return value ? response(200, { object: { sha: value } }) : response(404, { message: 'not found' });
    }
    if (method === 'GET' && path.startsWith('/git/commits/')) {
      const value = commits.get(path.slice('/git/commits/'.length));
      return value ? response(200, value) : response(404, {});
    }
    if (method === 'GET' && path.startsWith('/compare/')) {
      const [baseSha, headSha] = path.slice('/compare/'.length).split('...');
      let status = 'diverged';
      if (baseSha === headSha) status = 'identical';
      else if (isAncestor(baseSha, headSha)) status = 'ahead';
      else if (isAncestor(headSha, baseSha)) status = 'behind';
      return response(200, { status });
    }
    if (method === 'GET' && path.startsWith('/contents/')) {
      const contentPath = decodeURIComponent(path.slice('/contents/'.length));
      const refName = url.searchParams.get('ref');
      contentRefs.push(refName);
      const commitSha = /^[a-f0-9]{40}$/i.test(refName ?? '') ? refName.toLowerCase() : refs.get(refName);
      const commit = commits.get(commitSha);
      const tree = commit && trees.get(commit.tree.sha);
      const blobSha = tree?.get(contentPath);
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
      lastCreatedCommit = id;
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
      if (!current || body.force !== false || !isAncestor(current, body.sha)) return response(422, {});
      refs.set(ref, body.sha);
      return response(200, { ref, object: { sha: body.sha } });
    }
    throw new Error(`unexpected fake GitHub request: ${method} ${path}`);
  };

  const tamperCurrentStateHash = ({ tag = 'agent-cloud-state-v1', statePath = '.agent/cloud-state.json' } = {}) => {
    const commit = commits.get(refs.get(`refs/tags/${tag}`));
    const tree = trees.get(commit.tree.sha);
    const blobSha = tree.get(statePath);
    const envelope = JSON.parse(blobs.get(blobSha));
    envelope.stateHash = '0'.repeat(64);
    blobs.set(blobSha, JSON.stringify(envelope));
  };

  const forceRef = (ref, commitSha) => {
    refs.set(ref, commitSha);
  };

  const deleteRef = (ref) => {
    refs.delete(ref);
  };

  const failNextRefWrite = (ref, status = 500) => {
    failures.push({
      method: ref.startsWith('refs/tags/') && refs.has(ref) ? 'PATCH' : 'POST',
      status,
      match(path, body) {
        if (this.method === 'PATCH') return path === `/git/${ref}`;
        return path === '/git/refs' && body?.ref === ref;
      }
    });
  };

  return {
    fetchImpl,
    tamperCurrentStateHash,
    forceRef,
    deleteRef,
    failNextRefWrite,
    ref: (name) => refs.get(name) ?? null,
    lastCreatedCommit: () => lastCreatedCommit,
    contentRefs
  };
}

function storeFor(fake, {
  ownerId = 'github:1:1',
  now = () => Date.now(),
  leaseTtlMs = 60_000,
  laneId = 'self',
  allowedProjectIds = ['self'],
  tag = 'agent-cloud-state-v1',
  checkpointTag = `${tag}-checkpoint-v2`,
  statePath = '.agent/cloud-state.json'
} = {}) {
  return new GitHubStateStore({
    repository: { owner: 'palgarra14-del', name: 'agente-automatizador' },
    token: 'test-token-not-a-real-secret',
    fetchImpl: fake.fetchImpl,
    ownerId,
    now,
    leaseTtlMs,
    laneId,
    allowedProjectIds,
    tag,
    checkpointTag,
    statePath
  });
}

function cloneState(state) {
  return structuredClone(state);
}

test('cloud state enforces explicit project ownership and secret boundaries', () => {
  assert.throws(() => validateCloudState({ runs: { r: { projectId: 'callflow' } }, approvals: {}, events: [] }), /ownership_mismatch/);
  assert.doesNotThrow(() => validateCloudState(
    { runs: { r: { projectId: 'website-pilot' } }, approvals: {}, events: [] },
    { allowedProjectIds: ['website-pilot'] }
  ));
  assert.throws(() => validateCloudState(
    { workflows: { w: { projectId: 'self' } }, approvals: {}, events: [] },
    { allowedProjectIds: ['website-pilot'] }
  ), /ownership_mismatch/);
  assert.throws(() => validateCloudState({ runs: {}, approvals: {}, events: [], nested: { apiToken: 'value' } }), /sensitive_key/);
  assert.doesNotThrow(() => validateCloudState({
    runs: {},
    approvals: {},
    events: [],
    browser: { sessionId: 'visual-review-1' },
    workflows: { w: { projectId: 'self', modelUsage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } } }
  }));
  assert.throws(() => validateCloudState({
    runs: {}, approvals: {}, events: [], diagnostic: 'Authorization: Bearer ghp_exampletoken123'
  }), /contains_secret_material/);
});

test('durable state bootstraps state and checkpoint refs and resumes across ephemeral stores', async () => {
  const fake = fakeGitHub();
  const first = storeFor(fake, { ownerId: 'github:10:1' });
  await first.withGlobalLease(async () => {
    await first.mutate((state) => {
      state.workflows = { w1: { id: 'w1', projectId: 'self', status: 'pending', executionLease: null } };
    });
  });

  assert.ok(fake.ref('refs/tags/agent-cloud-state-v1'));
  assert.equal(fake.ref('refs/tags/agent-cloud-state-v1'), fake.ref('refs/tags/agent-cloud-state-v1-checkpoint-v2'));
  assert.ok(fake.ref('refs/tags/agent-cloud-state-v1-checkpoint-v2-initialized-v2'));

  const second = storeFor(fake, { ownerId: 'github:11:1' });
  const loaded = await second.load();
  assert.equal(loaded.workflows.w1.projectId, 'self');
  assert.equal(loaded.workflows.w1.status, 'pending');
  assert.equal(loaded.cloudExecutionLease, null);
  assert.ok(fake.contentRefs.length > 0);
  assert.ok(fake.contentRefs.every((ref) => /^[a-f0-9]{40}$/i.test(ref)));
});

test('durable writes strip worker shell output but keep bounded status/summary evidence', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake, { ownerId: 'github:12:1' });
  await store.withGlobalLease(async () => {
    await store.mutate((state) => {
      state.workflows = {
        w1: {
          id: 'w1',
          projectId: 'self',
          status: 'pending',
          executionLease: null,
          steps: [{
            id: 'implementation',
            evidence: {
              workerEvidence: {
                status: 'completed',
                summary: 'bounded safe summary',
                output: 'raw shell output that must not persist',
                diagnostics: ['raw diagnostic output']
              }
            }
          }]
        }
      };
    });
  });
  const loaded = await store.load();
  const evidence = loaded.workflows.w1.steps[0].evidence.workerEvidence;
  assert.equal(evidence.status, 'completed');
  assert.equal(evidence.summary, 'bounded safe summary');
  assert.equal(Object.hasOwn(evidence, 'output'), false);
  assert.equal(Object.hasOwn(evidence, 'diagnostics'), false);
});

test('independent cloud lanes use separate state/checkpoint refs and durable namespaces without clobbering', async () => {
  const fake = fakeGitHub();
  const selfStore = storeFor(fake, { ownerId: 'github:self:1' });
  const websiteStore = storeFor(fake, {
    ownerId: 'github:website:1',
    laneId: 'website-pilot',
    allowedProjectIds: ['website-pilot'],
    tag: 'agent-cloud-state-website-pilot-v1',
    statePath: '.agent/cloud-state-website-pilot.json'
  });

  await Promise.all([
    selfStore.withGlobalLease(async () => {
      await selfStore.mutate((state) => {
        state.workflows = { self1: { id: 'self1', projectId: 'self', status: 'pending', executionLease: null } };
      });
    }),
    websiteStore.withGlobalLease(async () => {
      await websiteStore.mutate((state) => {
        state.workflows = { web1: { id: 'web1', projectId: 'website-pilot', status: 'pending', executionLease: null } };
      });
    })
  ]);

  const selfState = await selfStore.load();
  const websiteState = await websiteStore.load();
  assert.equal(selfState.workflows.self1.projectId, 'self');
  assert.equal(Object.hasOwn(selfState.workflows, 'web1'), false);
  assert.equal(websiteState.workflows.web1.projectId, 'website-pilot');
  assert.equal(Object.hasOwn(websiteState.workflows, 'self1'), false);
  assert.equal(selfState.cloudExecutionLease, null);
  assert.equal(websiteState.cloudExecutionLease, null);
  assert.equal(fake.ref('refs/tags/agent-cloud-state-v1'), fake.ref('refs/tags/agent-cloud-state-v1-checkpoint-v2'));
  assert.equal(fake.ref('refs/tags/agent-cloud-state-website-pilot-v1'), fake.ref('refs/tags/agent-cloud-state-website-pilot-v1-checkpoint-v2'));
  assert.notEqual(fake.ref('refs/tags/agent-cloud-state-v1'), fake.ref('refs/tags/agent-cloud-state-website-pilot-v1'));
});

test('lane envelope binding rejects reading another lane through the wrong store', async () => {
  const fake = fakeGitHub();
  const websiteStore = storeFor(fake, {
    ownerId: 'github:website:2',
    laneId: 'website-pilot',
    allowedProjectIds: ['website-pilot'],
    tag: 'agent-cloud-state-website-pilot-v1',
    statePath: '.agent/cloud-state-website-pilot.json'
  });
  await websiteStore.withGlobalLease(async () => {
    await websiteStore.mutate((state) => {
      state.workflows = { web1: { id: 'w1', projectId: 'website-pilot', status: 'pending', executionLease: null } };
    });
  });

  const wrongLane = storeFor(fake, {
    ownerId: 'github:wrong:1',
    laneId: 'callflow',
    allowedProjectIds: ['website-pilot'],
    tag: 'agent-cloud-state-website-pilot-v1',
    statePath: '.agent/cloud-state-website-pilot.json'
  });
  await assert.rejects(wrongLane.load(), /cloud_state_lane_mismatch/);
});

test('fresh process rejects forced state rollback while checkpoint remains newer', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake, { ownerId: 'github:rollback:a' });
  const initial = await writer.readSnapshot();
  const state1 = cloneState(initial.state);
  state1.marker = 'n';
  const sha1 = await writer.writeSnapshot(state1, initial);
  const snap1 = await writer.readSnapshot();
  const state2 = cloneState(snap1.state);
  state2.marker = 'n+1';
  const sha2 = await writer.writeSnapshot(state2, snap1);
  assert.notEqual(sha1, sha2);

  fake.forceRef('refs/tags/agent-cloud-state-v1', sha1);
  const fresh = storeFor(fake, { ownerId: 'github:rollback:b' });
  await assert.rejects(fresh.load(), /cloud_state_rollback/);
});

test('fresh process rejects divergent higher generation and same-generation fork from trusted checkpoint', async () => {
  const fake = fakeGitHub();
  const a = storeFor(fake, { ownerId: 'github:fork:a' });
  const seed = await a.readSnapshot();
  const seededState = cloneState(seed.state);
  seededState.marker = 'seed';
  await a.writeSnapshot(seededState, seed);

  const b = storeFor(fake, { ownerId: 'github:fork:b' });
  const snapA = await a.readSnapshot();
  const snapB = await b.readSnapshot();

  fake.failNextRefWrite('refs/tags/agent-cloud-state-v1', 500);
  const nextB = cloneState(snapB.state);
  nextB.marker = 'divergent-child';
  await assert.rejects(b.writeSnapshot(nextB, snapB), /cloud_state_github_request_failed:500/);
  const divergentSha = fake.lastCreatedCommit();

  const nextA = cloneState(snapA.state);
  nextA.marker = 'accepted-child';
  const acceptedSha = await a.writeSnapshot(nextA, snapA);
  assert.notEqual(divergentSha, acceptedSha);

  fake.forceRef('refs/tags/agent-cloud-state-v1', divergentSha);
  const fresh = storeFor(fake, { ownerId: 'github:fork:fresh' });
  await assert.rejects(fresh.load(), /cloud_state_same_generation_fork|cloud_state_history_fork/);
});

test('fresh process accepts legitimate descendant with matching checkpoint', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake, { ownerId: 'github:descendant:a' });
  const initial = await writer.readSnapshot();
  const state = cloneState(initial.state);
  state.marker = 'legitimate';
  await writer.writeSnapshot(state, initial);

  const fresh = storeFor(fake, { ownerId: 'github:descendant:b' });
  const loaded = await fresh.load();
  assert.equal(loaded.marker, 'legitimate');
});

test('interruption after state-ref publication fails writer and fresh process advances checkpoint without rollback', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake, { ownerId: 'github:partial:a' });
  const initial = await writer.readSnapshot();
  const seed = cloneState(initial.state);
  seed.marker = 'seed';
  await writer.writeSnapshot(seed, initial);
  const before = await writer.readSnapshot();
  const oldSha = before.refSha;

  fake.failNextRefWrite('refs/tags/agent-cloud-state-v1-checkpoint-v2', 500);
  const next = cloneState(before.state);
  next.marker = 'published-state-only';
  await assert.rejects(writer.writeSnapshot(next, before), /cloud_state_partial_publication/);
  const newStateSha = fake.ref('refs/tags/agent-cloud-state-v1');
  assert.notEqual(newStateSha, oldSha);
  assert.equal(fake.ref('refs/tags/agent-cloud-state-v1-checkpoint-v2'), oldSha);

  const fresh = storeFor(fake, { ownerId: 'github:partial:b' });
  const recovered = await fresh.load();
  assert.equal(recovered.marker, 'published-state-only');
  assert.equal(fake.ref('refs/tags/agent-cloud-state-v1'), newStateSha);
  assert.equal(fake.ref('refs/tags/agent-cloud-state-v1-checkpoint-v2'), newStateSha);
});

test('interruption before state-ref publication leaves prior authoritative refs intact', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake, { ownerId: 'github:prestate:a' });
  const initial = await writer.readSnapshot();
  const seed = cloneState(initial.state);
  seed.marker = 'seed';
  await writer.writeSnapshot(seed, initial);
  const before = await writer.readSnapshot();

  fake.failNextRefWrite('refs/tags/agent-cloud-state-v1', 500);
  const next = cloneState(before.state);
  next.marker = 'must-not-publish';
  await assert.rejects(writer.writeSnapshot(next, before), /cloud_state_github_request_failed:500/);
  assert.equal(fake.ref('refs/tags/agent-cloud-state-v1'), before.refSha);
  assert.equal(fake.ref('refs/tags/agent-cloud-state-v1-checkpoint-v2'), before.checkpointSha);
});

test('state-only initial bootstrap recovery validates history and creates durable checkpoint', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake, { ownerId: 'github:migration:a' });
  const initial = await writer.readSnapshot();
  const state = cloneState(initial.state);
  state.marker = 'initial-state';
  const sha = await writer.writeSnapshot(state, initial);
  fake.deleteRef('refs/tags/agent-cloud-state-v1-checkpoint-v2');
  fake.deleteRef('refs/tags/agent-cloud-state-v1-checkpoint-v2-initialized-v2');

  const fresh = storeFor(fake, { ownerId: 'github:migration:b' });
  const loaded = await fresh.load();
  assert.equal(loaded.marker, 'initial-state');
  assert.equal(fake.ref('refs/tags/agent-cloud-state-v1-checkpoint-v2'), sha);
  assert.equal(fake.ref('refs/tags/agent-cloud-state-v1-checkpoint-v2-initialized-v2'), sha);
});

test('checkpoint without state ref fails closed as partial publication', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake, { ownerId: 'github:partialonly:a' });
  const initial = await writer.readSnapshot();
  const state = cloneState(initial.state);
  state.marker = 'seed';
  await writer.writeSnapshot(state, initial);
  fake.deleteRef('refs/tags/agent-cloud-state-v1');

  const fresh = storeFor(fake, { ownerId: 'github:partialonly:b' });
  await assert.rejects(fresh.load(), /cloud_state_partial_publication/);
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

test('optimistic state ref update rejects stale writers and checkpoint does not advance', async () => {
  const fake = fakeGitHub();
  const first = storeFor(fake, { ownerId: 'github:30:1' });
  const seedLease = await first.claimGlobalLease();
  await first.releaseGlobalLease(seedLease.leaseId);

  const second = storeFor(fake, { ownerId: 'github:31:1' });
  const a = await first.readSnapshot();
  const b = await second.readSnapshot();
  a.state.marker = 'first';
  b.state.marker = 'second';
  const winningSha = await first.writeSnapshot(a.state, a);
  await assert.rejects(second.writeSnapshot(b.state, b), /cloud_state_conflict/);
  assert.equal(fake.ref('refs/tags/agent-cloud-state-v1'), winningSha);
  assert.equal(fake.ref('refs/tags/agent-cloud-state-v1-checkpoint-v2'), winningSha);
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
