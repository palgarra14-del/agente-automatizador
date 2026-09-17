import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function hashState(state) {
  return createHash('sha256').update(JSON.stringify(canonical(state))).digest('hex');
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function blankState(marker) {
  return { runs: {}, approvals: {}, events: [], ...(marker === undefined ? {} : { marker }) };
}

function checkpointTagFor(tag) {
  return `agent-cloud-state-v2-checkpoints/${tag}`;
}

function witnessTagFor(tag) {
  return `agent-cloud-state-v2-witnesses/${tag}`;
}

function fakeGitHub() {
  let sequence = 10;
  let writeCount = 0;
  const sha = () => (sequence++).toString(16).padStart(40, '0');
  const mainSha = 'a'.repeat(40);
  const mainTree = 'b'.repeat(40);
  const refs = new Map([['refs/heads/main', mainSha]]);
  const commits = new Map([[mainSha, { sha: mainSha, tree: { sha: mainTree }, parents: [] }]]);
  const trees = new Map([[mainTree, new Map()]]);
  const blobs = new Map();
  const failures = [];
  const contentRefs = [];

  const fullTagRef = (value) => value.startsWith('refs/') ? value : `refs/tags/${value}`;
  const isAncestor = (ancestorSha, descendantSha) => {
    if (ancestorSha === descendantSha) return true;
    const stack = [descendantSha];
    const seen = new Set();
    while (stack.length) {
      const current = stack.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      for (const parent of commits.get(current)?.parents ?? []) {
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
    if (method !== 'GET') writeCount += 1;
    const injected = maybeFail(method, path, body);
    if (injected) return injected;

    if (method === 'GET' && path.startsWith('/git/ref/')) {
      const ref = `refs/${decodeURIComponent(path.slice('/git/ref/'.length))}`;
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
      return response(201, { sha: id });
    }
    if (method === 'POST' && path === '/git/refs') {
      if (refs.has(body.ref)) return response(422, {});
      refs.set(body.ref, body.sha);
      return response(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if (method === 'PATCH' && path.startsWith('/git/refs/tags/')) {
      const ref = `refs/tags/${decodeURIComponent(path.slice('/git/refs/tags/'.length))}`;
      const current = refs.get(ref);
      if (!current || body.force !== false || !isAncestor(current, body.sha)) return response(422, {});
      refs.set(ref, body.sha);
      return response(200, { ref, object: { sha: body.sha } });
    }
    throw new Error(`unexpected fake GitHub request: ${method} ${path}`);
  };

  const makeStateCommit = ({
    parentSha = mainSha,
    generation,
    state,
    version = 2,
    laneId = 'self',
    tag = 'agent-cloud-state-v1',
    checkpointTag = checkpointTagFor(tag),
    witnessTag = witnessTagFor(tag),
    statePath = '.agent/cloud-state.json'
  }) => {
    const parent = commits.get(parentSha);
    assert.ok(parent);
    const envelope = {
      version,
      repository: 'palgarra14-del/agente-automatizador',
      laneId,
      generation,
      stateHash: hashState(state),
      updatedAt: '2026-09-17T00:00:00.000Z',
      state
    };
    if (version === 2) {
      envelope.statePath = statePath;
      envelope.stateTag = tag;
      envelope.checkpointTag = checkpointTag;
      envelope.witnessTag = witnessTag;
    }
    const blobSha = sha();
    blobs.set(blobSha, JSON.stringify(envelope));
    const treeSha = sha();
    const tree = new Map(trees.get(parent.tree.sha) ?? []);
    tree.set(statePath, blobSha);
    trees.set(treeSha, tree);
    const commitSha = sha();
    commits.set(commitSha, { sha: commitSha, tree: { sha: treeSha }, parents: [{ sha: parentSha }] });
    return commitSha;
  };

  const tamperCurrentStateHash = ({ tag = 'agent-cloud-state-v1', statePath = '.agent/cloud-state.json' } = {}) => {
    const commit = commits.get(refs.get(`refs/tags/${tag}`));
    const tree = trees.get(commit.tree.sha);
    const blobSha = tree.get(statePath);
    const envelope = JSON.parse(blobs.get(blobSha));
    envelope.stateHash = '0'.repeat(64);
    blobs.set(blobSha, JSON.stringify(envelope));
  };

  const envelopeAt = (commitSha, statePath = '.agent/cloud-state.json') => {
    const commit = commits.get(commitSha);
    const blobSha = trees.get(commit.tree.sha).get(statePath);
    return JSON.parse(blobs.get(blobSha));
  };

  const aliasStatePath = (commitSha, fromPath, toPath) => {
    const commit = commits.get(commitSha);
    const tree = trees.get(commit.tree.sha);
    tree.set(toPath, tree.get(fromPath));
  };

  const failNextTagWrite = (tag, status = 500) => {
    const ref = fullTagRef(tag);
    failures.push({
      method: refs.has(ref) ? 'PATCH' : 'POST',
      status,
      match(path, body) {
        if (this.method === 'PATCH') return decodeURIComponent(path) === `/git/${ref}`;
        return path === '/git/refs' && body?.ref === ref;
      }
    });
  };

  return {
    fetchImpl,
    mainSha,
    makeStateCommit,
    tamperCurrentStateHash,
    envelopeAt,
    aliasStatePath,
    failNextTagWrite,
    forceTag(tag, commitSha) { refs.set(fullTagRef(tag), commitSha); },
    deleteTag(tag) { refs.delete(fullTagRef(tag)); },
    tagSha(tag) { return refs.get(fullTagRef(tag)) ?? null; },
    tryFastForwardTag(tag, commitSha) {
      const ref = fullTagRef(tag);
      const current = refs.get(ref);
      if (!current || !isAncestor(current, commitSha)) return false;
      refs.set(ref, commitSha);
      return true;
    },
    resetWriteCount() { writeCount = 0; },
    writeCount() { return writeCount; },
    clearContentRefs() { contentRefs.length = 0; },
    contentRefs() { return [...contentRefs]; }
  };
}

function storeFor(fake, {
  ownerId = 'github:1:1',
  now = () => Date.now(),
  leaseTtlMs = 60_000,
  laneId = 'self',
  allowedProjectIds = ['self'],
  tag = 'agent-cloud-state-v1',
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
    statePath
  });
}

const stateTag = 'agent-cloud-state-v1';
const checkpointTag = checkpointTagFor(stateTag);
const witnessTag = witnessTagFor(stateTag);

async function publishMarker(store, marker) {
  const snapshot = await store.readSnapshot();
  const state = cloneState(snapshot.state);
  state.marker = marker;
  return store.writeSnapshot(state, snapshot);
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
    runs: {}, approvals: {}, events: [], browser: { sessionId: 'visual-review-1' },
    workflows: { w: { projectId: 'self', modelUsage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } } }
  }));
  assert.throws(() => validateCloudState({
    runs: {}, approvals: {}, events: [], diagnostic: 'Authorization: Bearer ghp_exampletoken123'
  }), /contains_secret_material/);
});

test('durable state bootstraps three aligned refs and resumes across ephemeral stores without read writes', async () => {
  const fake = fakeGitHub();
  const first = storeFor(fake, { ownerId: 'github:10:1' });
  await first.withGlobalLease(async () => {
    await first.mutate((state) => {
      state.workflows = { w1: { id: 'w1', projectId: 'self', status: 'pending', executionLease: null } };
    });
  });

  const stateSha = fake.tagSha(stateTag);
  assert.equal(fake.tagSha(checkpointTag), stateSha);
  assert.equal(fake.tagSha(witnessTag), stateSha);
  fake.resetWriteCount();
  fake.clearContentRefs();

  const loaded = await storeFor(fake, { ownerId: 'github:11:1' }).load();
  assert.equal(loaded.workflows.w1.projectId, 'self');
  assert.equal(loaded.workflows.w1.status, 'pending');
  assert.equal(loaded.cloudExecutionLease, null);
  assert.equal(fake.writeCount(), 0);
  assert.ok(fake.contentRefs().length > 0);
  assert.ok(fake.contentRefs().every((ref) => /^[a-f0-9]{40}$/i.test(ref)));
});

test('legacy multi-generation state migrates to a v2 child and ignores mutable snapshot generation', async () => {
  const fake = fakeGitHub();
  const legacy1 = fake.makeStateCommit({ generation: 1, state: blankState('legacy-1'), version: 1 });
  const legacy2 = fake.makeStateCommit({ parentSha: legacy1, generation: 2, state: blankState('legacy-2'), version: 1 });
  fake.forceTag(stateTag, legacy2);

  const store = storeFor(fake, { ownerId: 'github:migrate:1' });
  const snapshot = await store.readSnapshot();
  assert.equal(snapshot.envelopeVersion, 1);
  assert.equal(snapshot.generation, 2);
  assert.equal(fake.tagSha(checkpointTag), null);
  assert.equal(fake.tagSha(witnessTag), null);
  snapshot.generation = 999;
  const next = cloneState(snapshot.state);
  next.marker = 'migrated';
  const migratedSha = await store.writeSnapshot(next, snapshot);
  const envelope = fake.envelopeAt(migratedSha);
  assert.equal(envelope.version, 2);
  assert.equal(envelope.generation, 3);
  assert.equal(envelope.statePath, '.agent/cloud-state.json');
  assert.equal(envelope.stateTag, stateTag);
  assert.equal(envelope.checkpointTag, checkpointTag);
  assert.equal(envelope.witnessTag, witnessTag);
  assert.equal(fake.tagSha(stateTag), migratedSha);
  assert.equal(fake.tagSha(checkpointTag), migratedSha);
  assert.equal(fake.tagSha(witnessTag), migratedSha);
});

test('legacy histories beyond 2048 generations remain migratable', async () => {
  const fake = fakeGitHub();
  let head = fake.mainSha;
  for (let generation = 1; generation <= 2050; generation += 1) {
    head = fake.makeStateCommit({ parentSha: head, generation, state: blankState(`legacy-${generation}`), version: 1 });
  }
  fake.forceTag(stateTag, head);
  const store = storeFor(fake, { ownerId: 'github:migrate:deep' });
  const snapshot = await store.readSnapshot();
  assert.equal(snapshot.generation, 2050);
  const migratedSha = await store.writeSnapshot(blankState('migrated-deep'), snapshot);
  assert.equal(fake.envelopeAt(migratedSha).generation, 2051);
  assert.equal(fake.tagSha(checkpointTag), migratedSha);
  assert.equal(fake.tagSha(witnessTag), migratedSha);
});

test('legacy writer racing migration cannot overwrite a winning v2 transition', async () => {
  const fake = fakeGitHub();
  const legacy = fake.makeStateCommit({ generation: 1, state: blankState('legacy'), version: 1 });
  fake.forceTag(stateTag, legacy);

  const migrating = storeFor(fake, { ownerId: 'github:migrate:a' });
  const staleSnapshot = await migrating.readSnapshot();
  const oldWriterChild = fake.makeStateCommit({ parentSha: legacy, generation: 2, state: blankState('old-writer'), version: 1 });
  assert.equal(fake.tryFastForwardTag(stateTag, oldWriterChild), true);
  await assert.rejects(migrating.writeSnapshot(blankState('stale-migration'), staleSnapshot), /cloud_state_conflict/);
  assert.equal(fake.tagSha(checkpointTag), null);
  assert.equal(fake.tagSha(witnessTag), null);

  const fresh = storeFor(fake, { ownerId: 'github:migrate:b' });
  const current = await fresh.readSnapshot();
  const migratedSha = await fresh.writeSnapshot(blankState('v2'), current);
  const obsoleteV1Child = fake.makeStateCommit({ parentSha: oldWriterChild, generation: 3, state: blankState('too-late-v1'), version: 1 });
  assert.equal(fake.tryFastForwardTag(stateTag, obsoleteV1Child), false);
  assert.equal(fake.tagSha(stateTag), migratedSha);
});

test('durable writes strip worker shell output but keep bounded status/summary evidence', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake, { ownerId: 'github:12:1' });
  await store.withGlobalLease(async () => {
    await store.mutate((state) => {
      state.workflows = {
        w1: {
          id: 'w1', projectId: 'self', status: 'pending', executionLease: null,
          steps: [{
            id: 'implementation',
            evidence: { workerEvidence: {
              status: 'completed', summary: 'bounded safe summary',
              output: 'raw shell output that must not persist', diagnostics: ['raw diagnostic output']
            } }
          }]
        }
      };
    });
  });
  const evidence = (await store.load()).workflows.w1.steps[0].evidence.workerEvidence;
  assert.equal(evidence.status, 'completed');
  assert.equal(evidence.summary, 'bounded safe summary');
  assert.equal(Object.hasOwn(evidence, 'output'), false);
  assert.equal(Object.hasOwn(evidence, 'diagnostics'), false);
});

test('independent cloud lanes isolate state and reserved watermark namespaces', async () => {
  const fake = fakeGitHub();
  const selfStore = storeFor(fake, { ownerId: 'github:self:1' });
  const websiteTag = 'agent-cloud-state-website-pilot-v1';
  const websiteStore = storeFor(fake, {
    ownerId: 'github:website:1', laneId: 'website-pilot', allowedProjectIds: ['website-pilot'],
    tag: websiteTag, statePath: '.agent/cloud-state-website-pilot.json'
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
  assert.equal(fake.tagSha(stateTag), fake.tagSha(checkpointTag));
  assert.equal(fake.tagSha(stateTag), fake.tagSha(witnessTag));
  assert.equal(fake.tagSha(websiteTag), fake.tagSha(checkpointTagFor(websiteTag)));
  assert.equal(fake.tagSha(websiteTag), fake.tagSha(witnessTagFor(websiteTag)));
  assert.notEqual(checkpointTagFor(stateTag), witnessTagFor(stateTag));
  assert.notEqual(checkpointTagFor(stateTag), checkpointTagFor(websiteTag));
  assert.notEqual(witnessTagFor(stateTag), witnessTagFor(websiteTag));
});

test('reserved watermark refs cannot collide with any valid explicit state tag', () => {
  const collidingLookingStateTag = 'agent-cloud-state-v1-checkpoint-v2';
  assert.doesNotThrow(() => storeFor(fakeGitHub(), { tag: collidingLookingStateTag }));
  assert.ok(checkpointTagFor(collidingLookingStateTag).includes('/'));
  assert.ok(witnessTagFor(collidingLookingStateTag).includes('/'));
  assert.doesNotMatch(collidingLookingStateTag, /\//);
  assert.notEqual(checkpointTagFor(collidingLookingStateTag), collidingLookingStateTag);
  assert.notEqual(witnessTagFor(collidingLookingStateTag), collidingLookingStateTag);
  assert.notEqual(checkpointTagFor(collidingLookingStateTag), witnessTagFor(collidingLookingStateTag));
});

test('lane envelope binding rejects reading another lane through the wrong store', async () => {
  const fake = fakeGitHub();
  const websiteTag = 'agent-cloud-state-website-pilot-v1';
  const websiteStore = storeFor(fake, {
    ownerId: 'github:website:2', laneId: 'website-pilot', allowedProjectIds: ['website-pilot'],
    tag: websiteTag, statePath: '.agent/cloud-state-website-pilot.json'
  });
  await websiteStore.withGlobalLease(async () => {
    await websiteStore.mutate((state) => {
      state.workflows = { web1: { id: 'web1', projectId: 'website-pilot', status: 'pending', executionLease: null } };
    });
  });
  const wrongLane = storeFor(fake, {
    ownerId: 'github:wrong:1', laneId: 'callflow', allowedProjectIds: ['website-pilot'],
    tag: websiteTag, statePath: '.agent/cloud-state-website-pilot.json'
  });
  await assert.rejects(wrongLane.load(), /cloud_state_lane_mismatch/);
});

test('v2 envelope binds the configured state path and derived watermark ref names', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const sha = await publishMarker(store, 'bound');
  fake.aliasStatePath(sha, '.agent/cloud-state.json', '.agent/alternate-state.json');
  const wrongPath = storeFor(fake, { statePath: '.agent/alternate-state.json', ownerId: 'github:path:wrong' });
  await assert.rejects(wrongPath.load(), /cloud_state_ref_binding_mismatch/);

  const alternateTag = 'alternate-state-v1';
  fake.forceTag(alternateTag, sha);
  fake.forceTag(checkpointTagFor(alternateTag), sha);
  fake.forceTag(witnessTagFor(alternateTag), sha);
  const wrongRefs = storeFor(fake, { tag: alternateTag, ownerId: 'github:refs:wrong' });
  await assert.rejects(wrongRefs.load(), /cloud_state_ref_binding_mismatch/);
});

test('fresh process rejects forced rollback when checkpoint survives and witness is missing', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake);
  const n1 = await publishMarker(writer, 'n1');
  const n2 = await publishMarker(writer, 'n2');
  assert.notEqual(n1, n2);
  fake.deleteTag(witnessTag);
  fake.forceTag(stateTag, n1);
  await assert.rejects(storeFor(fake, { ownerId: 'github:rollback:checkpoint' }).load(), /cloud_state_rollback/);
});

test('fresh process rejects forced rollback when witness survives and checkpoint is missing', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake);
  const n1 = await publishMarker(writer, 'n1');
  const n2 = await publishMarker(writer, 'n2');
  assert.notEqual(n1, n2);
  fake.deleteTag(checkpointTag);
  fake.forceTag(stateTag, n1);
  await assert.rejects(storeFor(fake, { ownerId: 'github:rollback:witness' }).load(), /cloud_state_rollback/);
});

test('both watermarks missing from an established v2 history fail closed', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake);
  await publishMarker(writer, 'n1');
  await publishMarker(writer, 'n2');
  fake.deleteTag(checkpointTag);
  fake.deleteTag(witnessTag);
  await assert.rejects(storeFor(fake, { ownerId: 'github:no-watermarks' }).load(), /cloud_state_watermarks_missing/);
});

test('a forged skipped generation is rejected even when all three refs agree', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake);
  const n1 = await publishMarker(writer, 'n1');
  const n1Envelope = fake.envelopeAt(n1);
  const bad = fake.makeStateCommit({ parentSha: n1, generation: n1Envelope.generation + 2, state: blankState('n3') });
  fake.forceTag(stateTag, bad);
  fake.forceTag(checkpointTag, bad);
  fake.forceTag(witnessTag, bad);
  await assert.rejects(storeFor(fake, { ownerId: 'github:skip:fresh' }).load(), /cloud_state_generation_discontinuity/);
});

test('aligned refs still reject a malformed older v2 ancestor', async () => {
  const fake = fakeGitHub();
  const malformedGeneration2 = fake.makeStateCommit({
    parentSha: fake.mainSha, generation: 2, state: blankState('bad-generation-2')
  });
  const apparentlyValidGeneration3 = fake.makeStateCommit({
    parentSha: malformedGeneration2, generation: 3, state: blankState('looks-valid-generation-3')
  });
  fake.forceTag(stateTag, apparentlyValidGeneration3);
  fake.forceTag(checkpointTag, apparentlyValidGeneration3);
  fake.forceTag(witnessTag, apparentlyValidGeneration3);
  await assert.rejects(
    storeFor(fake, { ownerId: 'github:full-lineage:fresh' }).load(),
    /cloud_state_file_invalid|cloud_state_generation_discontinuity|cloud_state_bootstrap_ancestry_invalid/
  );
});

test('higher-generation divergent history is rejected despite its numeric generation', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake);
  const trusted = await publishMarker(writer, 'trusted');
  const trustedEnvelope = fake.envelopeAt(trusted);
  const divergent = fake.makeStateCommit({
    parentSha: fake.mainSha, generation: trustedEnvelope.generation + 5, state: blankState('divergent')
  });
  fake.forceTag(stateTag, divergent);
  await assert.rejects(storeFor(fake, { ownerId: 'github:fork:fresh' }).load(), /cloud_state_history_fork/);
});

test('legacy descendants are rejected once durable v2 watermarks exist', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake);
  const v2 = await publishMarker(writer, 'v2');
  const envelope = fake.envelopeAt(v2);
  const legacyChild = fake.makeStateCommit({
    parentSha: v2, generation: envelope.generation + 1, state: blankState('legacy-child'), version: 1
  });
  fake.forceTag(stateTag, legacyChild);
  fake.forceTag(checkpointTag, legacyChild);
  fake.forceTag(witnessTag, legacyChild);
  await assert.rejects(storeFor(fake, { ownerId: 'github:downgrade:fresh' }).load(), /cloud_state_legacy_after_migration/);
});

test('checkpoint publication failure still publishes witness and repair restores all refs', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake);
  const n1 = await publishMarker(writer, 'n1');
  const snapshot = await writer.readSnapshot();
  const next = cloneState(snapshot.state);
  next.marker = 'n2';
  fake.failNextTagWrite(checkpointTag, 500);
  await assert.rejects(writer.writeSnapshot(next, snapshot), /cloud_state_partial_publication/);
  const n2 = fake.tagSha(stateTag);
  assert.notEqual(n2, n1);
  assert.equal(fake.tagSha(checkpointTag), n1);
  assert.equal(fake.tagSha(witnessTag), n2);

  fake.resetWriteCount();
  assert.equal((await storeFor(fake, { ownerId: 'github:partial:peek' }).load()).marker, 'n2');
  assert.equal(fake.writeCount(), 0);
  const repaired = await storeFor(fake, { ownerId: 'github:partial:repair' }).readSnapshot({ repair: true });
  assert.equal(repaired.refSha, n2);
  assert.equal(fake.tagSha(checkpointTag), n2);
  assert.equal(fake.tagSha(witnessTag), n2);
});

test('witness publication failure leaves checkpoint proof and repair restores witness', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake);
  const n1 = await publishMarker(writer, 'n1');
  const snapshot = await writer.readSnapshot();
  const next = cloneState(snapshot.state);
  next.marker = 'n2';
  fake.failNextTagWrite(witnessTag, 500);
  await assert.rejects(writer.writeSnapshot(next, snapshot), /cloud_state_partial_publication/);
  const n2 = fake.tagSha(stateTag);
  assert.notEqual(n2, n1);
  assert.equal(fake.tagSha(checkpointTag), n2);
  assert.equal(fake.tagSha(witnessTag), n1);

  await storeFor(fake, { ownerId: 'github:witness:repair' }).readSnapshot({ repair: true });
  assert.equal(fake.tagSha(checkpointTag), n2);
  assert.equal(fake.tagSha(witnessTag), n2);
});

test('failure before state-ref publication leaves prior trusted refs intact', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake);
  const trusted = await publishMarker(writer, 'n1');
  const snapshot = await writer.readSnapshot();
  const next = cloneState(snapshot.state);
  next.marker = 'n2';
  fake.failNextTagWrite(stateTag, 500);
  await assert.rejects(writer.writeSnapshot(next, snapshot), /cloud_state_github_request_failed:500|cloud_state_conflict/);
  assert.equal(fake.tagSha(stateTag), trusted);
  assert.equal(fake.tagSha(checkpointTag), trusted);
  assert.equal(fake.tagSha(witnessTag), trusted);
});

test('two stale writers yield one winner and one conflict without watermark divergence', async () => {
  const fake = fakeGitHub();
  const first = storeFor(fake, { ownerId: 'github:writer:a' });
  await publishMarker(first, 'seed');
  const second = storeFor(fake, { ownerId: 'github:writer:b' });
  const a = await first.readSnapshot();
  const b = await second.readSnapshot();
  const stateA = cloneState(a.state);
  const stateB = cloneState(b.state);
  stateA.marker = 'a';
  stateB.marker = 'b';
  const winningSha = await first.writeSnapshot(stateA, a);
  await assert.rejects(second.writeSnapshot(stateB, b), /cloud_state_conflict/);
  assert.equal(fake.tagSha(stateTag), winningSha);
  assert.equal(fake.tagSha(checkpointTag), winningSha);
  assert.equal(fake.tagSha(witnessTag), winningSha);
});

test('concurrent recovery of the same partial publication is idempotent', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake);
  await publishMarker(writer, 'n1');
  const snapshot = await writer.readSnapshot();
  const next = cloneState(snapshot.state);
  next.marker = 'n2';
  fake.failNextTagWrite(witnessTag, 500);
  await assert.rejects(writer.writeSnapshot(next, snapshot), /cloud_state_partial_publication/);
  const target = fake.tagSha(stateTag);

  const [a, b] = await Promise.allSettled([
    storeFor(fake, { ownerId: 'github:recover:a' }).readSnapshot({ repair: true }),
    storeFor(fake, { ownerId: 'github:recover:b' }).readSnapshot({ repair: true })
  ]);
  assert.ok(a.status === 'fulfilled' || b.status === 'fulfilled');
  assert.equal(fake.tagSha(stateTag), target);
  assert.equal(fake.tagSha(checkpointTag), target);
  assert.equal(fake.tagSha(witnessTag), target);
});

test('same-generation different-SHA state is rejected against surviving watermarks', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake);
  const trusted = await publishMarker(writer, 'trusted');
  const trustedEnvelope = fake.envelopeAt(trusted);
  const sibling = fake.makeStateCommit({
    parentSha: fake.mainSha,
    generation: trustedEnvelope.generation,
    state: blankState('same-generation-fork')
  });
  fake.forceTag(stateTag, sibling);
  await assert.rejects(storeFor(fake, { ownerId: 'github:same-gen:fresh' }).load(), /cloud_state_history_fork/);
});

test('failure of both watermark publications after state advancement fails closed without re-trusting state', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake);
  const snapshot = await writer.readSnapshot();
  fake.failNextTagWrite(checkpointTag, 500);
  fake.failNextTagWrite(witnessTag, 500);
  await assert.rejects(writer.writeSnapshot(blankState('hard-partial'), snapshot), /cloud_state_partial_publication/);
  assert.ok(fake.tagSha(stateTag));
  assert.equal(fake.tagSha(checkpointTag), null);
  assert.equal(fake.tagSha(witnessTag), null);
  await assert.rejects(storeFor(fake, { ownerId: 'github:hard-partial:fresh' }).load(), /cloud_state_watermarks_missing/);
});

test('state content is always read by exact commit SHA rather than moving tags', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  await publishMarker(store, 'exact');
  fake.clearContentRefs();
  await storeFor(fake, { ownerId: 'github:exact:fresh' }).load();
  assert.ok(fake.contentRefs().length >= 1);
  assert.ok(fake.contentRefs().every((ref) => /^[a-f0-9]{40}$/i.test(ref)));
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