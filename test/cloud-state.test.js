import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { URL } from 'node:url';
import { GitHubStateStore, validateCloudState } from '../src/cloud-state.js';

const LEDGER_ROOT_SHA = 'b4f3b2e76e24be58d241227850a5d48ea19c2ea8';

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
  let statusId = 1;
  let writeCount = 0;
  let requestCount = 0;
  const refWrites = [];
  const statusWrites = [];
  const sha = () => (sequence++).toString(16).padStart(40, '0');
  const mainSha = 'a'.repeat(40);
  const mainTree = 'b'.repeat(40);
  const rootTree = 'c'.repeat(40);
  const refs = new Map([['refs/heads/main', mainSha]]);
  const commits = new Map([
    [LEDGER_ROOT_SHA, { sha: LEDGER_ROOT_SHA, tree: { sha: rootTree }, parents: [] }],
    [mainSha, { sha: mainSha, tree: { sha: mainTree }, parents: [{ sha: LEDGER_ROOT_SHA }] }]
  ]);
  const trees = new Map([[rootTree, new Map()], [mainTree, new Map()]]);
  const blobs = new Map();
  const failures = [];
  const contentRefs = [];
  const statuses = [];
  const truncatedBlobs = new Set();

  const fullTagRef = (value) => value.startsWith('refs/') ? value : `refs/tags/${value}`;
  const ancestorDistances = (startSha) => {
    const distances = new Map([[startSha, 0]]);
    const queue = [startSha];
    while (queue.length) {
      const current = queue.shift();
      const distance = distances.get(current);
      for (const parent of commits.get(current)?.parents ?? []) {
        if (distances.has(parent.sha)) continue;
        distances.set(parent.sha, distance + 1);
        queue.push(parent.sha);
      }
    }
    return distances;
  };
  const isAncestor = (ancestorSha, descendantSha) => ancestorDistances(descendantSha).has(ancestorSha);
  const comparePayload = (baseSha, headSha) => {
    if (baseSha === headSha) {
      return { status: 'identical', ahead_by: 0, behind_by: 0, merge_base_commit: { sha: baseSha } };
    }
    const baseDistances = ancestorDistances(baseSha);
    const headDistances = ancestorDistances(headSha);
    let mergeBaseSha = null;
    let mergeScore = Number.POSITIVE_INFINITY;
    for (const [candidate, headDistance] of headDistances.entries()) {
      const baseDistance = baseDistances.get(candidate);
      if (baseDistance === undefined) continue;
      const score = headDistance + baseDistance;
      if (score < mergeScore) {
        mergeScore = score;
        mergeBaseSha = candidate;
      }
    }
    if (!mergeBaseSha) return { status: 'diverged', ahead_by: 0, behind_by: 0, merge_base_commit: null };
    const aheadBy = headDistances.get(mergeBaseSha);
    const behindBy = baseDistances.get(mergeBaseSha);
    let status = 'diverged';
    if (behindBy === 0) status = 'ahead';
    else if (aheadBy === 0) status = 'behind';
    return { status, ahead_by: aheadBy, behind_by: behindBy, merge_base_commit: { sha: mergeBaseSha } };
  };

  const maybeFail = (method, path, body) => {
    const index = failures.findIndex((failure) => failure.method === method && failure.match(path, body));
    if (index === -1) return null;
    const [failure] = failures.splice(index, 1);
    return response(failure.status, { message: 'injected failure' });
  };

  const historyPayload = (variables) => {
    const chain = [];
    let currentSha = variables.oid;
    const seen = new Set();
    while (currentSha && !seen.has(currentSha)) {
      seen.add(currentSha);
      const commit = commits.get(currentSha);
      if (!commit) break;
      const tree = trees.get(commit.tree.sha);
      const blobSha = tree?.get(variables.path);
      const text = blobSha ? blobs.get(blobSha) : null;
      chain.push({
        oid: currentSha,
        parents: {
          totalCount: commit.parents.length,
          nodes: commit.parents.slice(0, 2).map((parent) => ({ oid: parent.sha }))
        },
        file: blobSha ? {
          object: {
            oid: blobSha,
            byteSize: Buffer.byteLength(text, 'utf8'),
            isBinary: false,
            isTruncated: truncatedBlobs.has(blobSha),
            text
          }
        } : null
      });
      currentSha = commit.parents[0]?.sha ?? null;
    }
    const offset = variables.after ? Number(String(variables.after).replace('cursor:', '')) : 0;
    const first = variables.first;
    const nodes = chain.slice(offset, offset + first);
    const nextOffset = offset + nodes.length;
    return {
      data: {
        repository: {
          object: {
            history: {
              nodes,
              pageInfo: {
                hasNextPage: nextOffset < chain.length,
                endCursor: nextOffset < chain.length ? `cursor:${nextOffset}` : null
              }
            }
          }
        }
      }
    };
  };

  const addStatus = ({ context, description, state = 'success', target_url = null }) => {
    const entry = {
      id: statusId++,
      state,
      description,
      target_url,
      context,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      creator: { login: 'github-actions[bot]', id: 1 }
    };
    statuses.unshift(entry);
    return entry;
  };

  const fetchImpl = async (rawUrl, options = {}) => {
    requestCount += 1;
    const url = new URL(rawUrl);
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : null;

    if (url.pathname === '/graphql') {
      assert.equal(method, 'POST');
      return response(200, historyPayload(body.variables));
    }

    const prefix = '/repos/palgarra14-del/agente-automatizador';
    assert.ok(url.pathname.startsWith(prefix));
    const path = url.pathname.slice(prefix.length);
    if (method !== 'GET') writeCount += 1;
    const injected = maybeFail(method, path, body);
    if (injected) return injected;

    if (method === 'GET' && path.startsWith(`/commits/${LEDGER_ROOT_SHA}/statuses`)) {
      const perPage = Number(url.searchParams.get('per_page') ?? '30');
      const page = Number(url.searchParams.get('page') ?? '1');
      const start = (page - 1) * perPage;
      return response(200, statuses.slice(start, start + perPage).map(cloneState));
    }
    if (method === 'POST' && path === `/statuses/${LEDGER_ROOT_SHA}`) {
      statusWrites.push(cloneState(body));
      return response(201, addStatus(body));
    }
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
      return response(200, comparePayload(baseSha, headSha));
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
      refWrites.push({ method, path, body: cloneState(body) });
      if (refs.has(body.ref)) return response(422, {});
      refs.set(body.ref, body.sha);
      return response(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if (method === 'PATCH' && path.startsWith('/git/refs/tags/')) {
      refWrites.push({ method, path, body: cloneState(body) });
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
    additionalParentShas = [],
    generation,
    state,
    version = 2,
    laneId = 'self',
    tag = 'agent-cloud-state-v1',
    checkpointTag = checkpointTagFor(tag),
    witnessTag = witnessTagFor(tag),
    statePath = '.agent/cloud-state.json',
    lineageBaseSha = mainSha,
    lineageBaseGeneration = 0
  }) => {
    const parent = commits.get(parentSha);
    assert.ok(parent);
    for (const extra of additionalParentShas) assert.ok(commits.has(extra));
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
      envelope.lineageBaseSha = lineageBaseSha;
      envelope.lineageBaseGeneration = lineageBaseGeneration;
    }
    const blobSha = sha();
    blobs.set(blobSha, JSON.stringify(envelope));
    const treeSha = sha();
    const tree = new Map(trees.get(parent.tree.sha) ?? []);
    tree.set(statePath, blobSha);
    trees.set(treeSha, tree);
    const commitSha = sha();
    commits.set(commitSha, {
      sha: commitSha,
      tree: { sha: treeSha },
      parents: [parentSha, ...additionalParentShas].map((parentValue) => ({ sha: parentValue }))
    });
    return commitSha;
  };

  const tamperEnvelope = (commitSha, mutator, statePath = '.agent/cloud-state.json') => {
    const commit = commits.get(commitSha);
    const tree = trees.get(commit.tree.sha);
    const blobSha = tree.get(statePath);
    const envelope = JSON.parse(blobs.get(blobSha));
    mutator(envelope);
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

  const failNextStatusWrite = (status = 500) => {
    failures.push({
      method: 'POST',
      status,
      match(path) { return path === `/statuses/${LEDGER_ROOT_SHA}`; }
    });
  };

  return {
    fetchImpl,
    mainSha,
    makeStateCommit,
    tamperEnvelope,
    envelopeAt,
    aliasStatePath,
    failNextTagWrite,
    failNextStatusWrite,
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
    forceStatus(context, description, options = {}) {
      return addStatus({ context, description, state: options.state ?? 'success', target_url: options.target_url ?? null });
    },
    statuses() { return statuses.map(cloneState); },
    statusWrites() { return statusWrites.map(cloneState); },
    refWrites() { return refWrites.map(cloneState); },
    resetWriteCount() { writeCount = 0; },
    writeCount() { return writeCount; },
    resetRequestCount() { requestCount = 0; },
    requestCount() { return requestCount; },
    clearContentRefs() { contentRefs.length = 0; },
    contentRefs() { return [...contentRefs]; },
    markHistoryTruncated(commitSha, statePath = '.agent/cloud-state.json') {
      const commit = commits.get(commitSha);
      truncatedBlobs.add(trees.get(commit.tree.sha).get(statePath));
    },
    setRootParents(parentShas) {
      commits.get(LEDGER_ROOT_SHA).parents = parentShas.map((value) => ({ sha: value }));
    }
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

function installLedgerRecord(fake, store, generation, stateSha, parentSha) {
  fake.forceStatus(store.ledgerContext(generation), store.ledgerDescription(stateSha, parentSha));
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
  assert.throws(() => validateCloudState({ runs: {}, approvals: {}, events: [], diagnostic: 'Authorization: Bearer ghp_exampletoken123' }), /contains_secret_material/);
});

test('status authority is anchored to the verified parentless repository root', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  assert.deepEqual(await store.readStatusLedger(), []);
  fake.setRootParents([fake.mainSha]);
  await assert.rejects(storeFor(fake, { ownerId: 'github:root:bad' }).readStatusLedger(), /cloud_state_status_root_invalid/);
});

test('durable bootstrap appends status authority and fresh load is read-only', async () => {
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
  const ledger = await storeFor(fake, { ownerId: 'github:ledger:peek' }).readStatusLedger();
  assert.equal(ledger.at(-1).stateSha, stateSha);
  fake.resetWriteCount();
  fake.clearContentRefs();
  const loaded = await storeFor(fake, { ownerId: 'github:11:1' }).load();
  assert.equal(loaded.workflows.w1.projectId, 'self');
  assert.equal(fake.writeCount(), 0);
  assert.ok(fake.contentRefs().length > 0);
  assert.ok(fake.contentRefs().every((ref) => /^[a-f0-9]{40}$/i.test(ref)));
});

test('legacy multi-generation state migrates to first v2 status authority', async () => {
  const fake = fakeGitHub();
  const legacy1 = fake.makeStateCommit({ generation: 1, state: blankState('legacy-1'), version: 1 });
  const legacy2 = fake.makeStateCommit({ parentSha: legacy1, generation: 2, state: blankState('legacy-2'), version: 1 });
  fake.forceTag(stateTag, legacy2);
  const store = storeFor(fake, { ownerId: 'github:migrate:1' });
  const snapshot = await store.readSnapshot();
  assert.equal(snapshot.envelopeVersion, 1);
  assert.equal(snapshot.generation, 2);
  const migratedSha = await store.writeSnapshot(blankState('migrated'), snapshot);
  const envelope = fake.envelopeAt(migratedSha);
  assert.equal(envelope.version, 2);
  assert.equal(envelope.generation, 3);
  assert.equal(envelope.lineageBaseSha, legacy2);
  assert.equal(envelope.lineageBaseGeneration, 2);
  const ledger = await store.readStatusLedger();
  assert.deepEqual(ledger, [{ generation: 3, stateSha: migratedSha, parentSha: legacy2 }]);
});

test('legacy histories beyond 2048 generations migrate with bounded requests', async () => {
  const fake = fakeGitHub();
  let head = fake.mainSha;
  for (let generation = 1; generation <= 2050; generation += 1) {
    head = fake.makeStateCommit({ parentSha: head, generation, state: blankState(`legacy-${generation}`), version: 1 });
  }
  fake.forceTag(stateTag, head);
  fake.resetRequestCount();
  const store = storeFor(fake, { ownerId: 'github:migrate:deep' });
  const snapshot = await store.readSnapshot();
  const migratedSha = await store.writeSnapshot(blankState('migrated-deep'), snapshot);
  assert.equal(fake.envelopeAt(migratedSha).generation, 2051);
  assert.ok(fake.requestCount() < 60, `expected bounded migration traffic, received ${fake.requestCount()} requests`);
});

test('legacy migration preserves inherited generation offsets', async () => {
  const fake = fakeGitHub();
  const legacyA = fake.makeStateCommit({ generation: 4, state: blankState('offset-4'), version: 1 });
  const legacyB = fake.makeStateCommit({ parentSha: legacyA, generation: 5, state: blankState('offset-5'), version: 1 });
  fake.forceTag(stateTag, legacyB);
  const store = storeFor(fake, { ownerId: 'github:migrate:offset' });
  const snapshot = await store.readSnapshot();
  const migratedSha = await store.writeSnapshot(blankState('offset-v2'), snapshot);
  const envelope = fake.envelopeAt(migratedSha);
  assert.equal(envelope.generation, 6);
  assert.equal(envelope.lineageBaseSha, legacyB);
  assert.equal(envelope.lineageBaseGeneration, 5);
});

test('first-v2 crash after state CAS but before status append is repair-only', async () => {
  const fake = fakeGitHub();
  const legacy = fake.makeStateCommit({ generation: 1, state: blankState('legacy'), version: 1 });
  fake.forceTag(stateTag, legacy);
  const store = storeFor(fake, { ownerId: 'github:migrate:crash' });
  const snapshot = await store.readSnapshot();
  fake.failNextStatusWrite(500);
  await assert.rejects(store.writeSnapshot(blankState('v2-partial'), snapshot), /cloud_state_partial_publication/);
  const partialSha = fake.tagSha(stateTag);
  assert.notEqual(partialSha, legacy);
  assert.deepEqual(await store.readStatusLedger(), []);
  await assert.rejects(storeFor(fake, { ownerId: 'github:migrate:peek' }).load(), /cloud_state_status_ledger_missing/);
  const repaired = await storeFor(fake, { ownerId: 'github:migrate:repair' }).readSnapshot({ repair: true });
  assert.equal(repaired.refSha, partialSha);
  assert.equal(fake.tagSha(checkpointTag), partialSha);
  assert.equal(fake.tagSha(witnessTag), partialSha);
  assert.equal((await storeFor(fake, { ownerId: 'github:migrate:post' }).readStatusLedger()).at(-1).stateSha, partialSha);
});

test('legacy writer racing migration cannot publish stale v2 authority', async () => {
  const fake = fakeGitHub();
  const legacy = fake.makeStateCommit({ generation: 1, state: blankState('legacy'), version: 1 });
  fake.forceTag(stateTag, legacy);
  const migrating = storeFor(fake, { ownerId: 'github:migrate:a' });
  const staleSnapshot = await migrating.readSnapshot();
  const oldWriterChild = fake.makeStateCommit({ parentSha: legacy, generation: 2, state: blankState('old-writer'), version: 1 });
  assert.equal(fake.tryFastForwardTag(stateTag, oldWriterChild), true);
  await assert.rejects(migrating.writeSnapshot(blankState('stale-migration'), staleSnapshot), /cloud_state_conflict/);
  assert.deepEqual(await migrating.readStatusLedger(), []);
  const fresh = storeFor(fake, { ownerId: 'github:migrate:b' });
  const current = await fresh.readSnapshot();
  const migratedSha = await fresh.writeSnapshot(blankState('v2'), current);
  assert.equal((await fresh.readStatusLedger()).at(-1).stateSha, migratedSha);
});

test('durable writes strip worker shell output but retain safe summary evidence', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake, { ownerId: 'github:evidence' });
  await store.withGlobalLease(async () => {
    await store.mutate((state) => {
      state.workflows = {
        w1: {
          id: 'w1', projectId: 'self', status: 'pending', executionLease: null,
          steps: [{ evidence: { workerEvidence: {
            status: 'completed', summary: 'bounded safe summary',
            output: 'raw shell output that must not persist', diagnostics: ['raw diagnostic output']
          } } }]
        }
      };
    });
  });
  const evidence = (await store.load()).workflows.w1.steps[0].evidence.workerEvidence;
  assert.equal(evidence.summary, 'bounded safe summary');
  assert.equal(Object.hasOwn(evidence, 'output'), false);
  assert.equal(Object.hasOwn(evidence, 'diagnostics'), false);
});

test('independent lanes use disjoint status contexts and state', async () => {
  const fake = fakeGitHub();
  const selfStore = storeFor(fake, { ownerId: 'github:self' });
  const websiteTag = 'agent-cloud-state-website-pilot-v1';
  const websiteStore = storeFor(fake, {
    ownerId: 'github:web', laneId: 'website-pilot', allowedProjectIds: ['website-pilot'],
    tag: websiteTag, statePath: '.agent/cloud-state-website-pilot.json'
  });
  await selfStore.withGlobalLease(async () => {
    await selfStore.mutate((state) => { state.workflows = { self1: { projectId: 'self' } }; });
  });
  await websiteStore.withGlobalLease(async () => {
    await websiteStore.mutate((state) => { state.workflows = { web1: { projectId: 'website-pilot' } }; });
  });
  assert.notEqual(selfStore.ledgerContext(1), websiteStore.ledgerContext(1));
  assert.equal((await selfStore.load()).workflows.self1.projectId, 'self');
  assert.equal((await websiteStore.load()).workflows.web1.projectId, 'website-pilot');
  assert.equal((await selfStore.readStatusLedger()).length, 3);
  assert.equal((await websiteStore.readStatusLedger()).length, 3);
});

test('reserved mutable namespace roots remain invalid state tags', () => {
  assert.throws(() => storeFor(fakeGitHub(), { tag: 'agent-cloud-state-v2-checkpoints' }), /cloud_state_tag_reserved/);
  assert.throws(() => storeFor(fakeGitHub(), { tag: 'agent-cloud-state-v2-witnesses' }), /cloud_state_tag_reserved/);
  assert.doesNotThrow(() => storeFor(fakeGitHub(), { tag: 'agent-cloud-state-v2-history' }));
});

test('status contexts are generation-specific and status writes only append to immutable root', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  await publishMarker(store, 'one');
  await publishMarker(store, 'two');
  assert.notEqual(store.ledgerContext(1), store.ledgerContext(2));
  assert.ok(store.ledgerContext(2).length < 100);
  assert.ok(fake.statusWrites().length >= 2);
  assert.ok(fake.statusWrites().every((entry) => entry.state === 'success' && entry.target_url === undefined));
  assert.ok(fake.refWrites().every((entry) => !decodeURIComponent(entry.path).includes('status')));
});

test('lane envelope binding rejects another lane', async () => {
  const fake = fakeGitHub();
  const websiteTag = 'agent-cloud-state-website-pilot-v1';
  const websiteStore = storeFor(fake, {
    ownerId: 'github:web:2', laneId: 'website-pilot', allowedProjectIds: ['website-pilot'],
    tag: websiteTag, statePath: '.agent/cloud-state-website-pilot.json'
  });
  await websiteStore.withGlobalLease(async () => {
    await websiteStore.mutate((state) => { state.workflows = { web1: { projectId: 'website-pilot' } }; });
  });
  const wrongLane = storeFor(fake, {
    ownerId: 'github:wrong', laneId: 'callflow', allowedProjectIds: ['website-pilot'],
    tag: websiteTag, statePath: '.agent/cloud-state-website-pilot.json'
  });
  await assert.rejects(wrongLane.load(), /cloud_state_status_ledger_missing|cloud_state_lane_mismatch/);
});

test('v2 envelope binds configured state path and derived watermark names', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const shaValue = await publishMarker(store, 'bound');
  fake.aliasStatePath(shaValue, '.agent/cloud-state.json', '.agent/alternate-state.json');
  const wrongPath = storeFor(fake, { statePath: '.agent/alternate-state.json', ownerId: 'github:path:wrong' });
  await assert.rejects(wrongPath.load(), /cloud_state_status_ledger_missing|cloud_state_ref_binding_mismatch/);
});

test('fresh process rejects joint rollback of all mutable refs and repair moves only forward', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake);
  const n1 = await publishMarker(writer, 'n1');
  const n2 = await publishMarker(writer, 'n2');
  fake.forceTag(stateTag, n1);
  fake.forceTag(checkpointTag, n1);
  fake.forceTag(witnessTag, n1);
  await assert.rejects(storeFor(fake, { ownerId: 'github:rollback:all' }).load(), /cloud_state_rollback/);
  const repaired = await storeFor(fake, { ownerId: 'github:rollback:repair' }).readSnapshot({ repair: true });
  assert.equal(repaired.refSha, n2);
  assert.equal(fake.tagSha(stateTag), n2);
  assert.equal(fake.tagSha(checkpointTag), n2);
  assert.equal(fake.tagSha(witnessTag), n2);
});

test('missing checkpoint and witness do not erase status authority or cause write-on-load', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake);
  const current = await publishMarker(writer, 'current');
  fake.deleteTag(checkpointTag);
  fake.deleteTag(witnessTag);
  fake.resetWriteCount();
  assert.equal((await storeFor(fake, { ownerId: 'github:no-watermarks:peek' }).load()).marker, 'current');
  assert.equal(fake.writeCount(), 0);
  await storeFor(fake, { ownerId: 'github:no-watermarks:repair' }).readSnapshot({ repair: true });
  assert.equal(fake.tagSha(checkpointTag), current);
  assert.equal(fake.tagSha(witnessTag), current);
});

test('same-generation sibling is rejected even when every mutable ref points to it', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake);
  const trusted = await publishMarker(writer, 'trusted');
  const envelope = fake.envelopeAt(trusted);
  const sibling = fake.makeStateCommit({
    parentSha: envelope.lineageBaseSha,
    generation: envelope.generation,
    state: blankState('same-generation-fork'),
    lineageBaseSha: envelope.lineageBaseSha,
    lineageBaseGeneration: envelope.lineageBaseGeneration
  });
  fake.forceTag(stateTag, sibling);
  fake.forceTag(checkpointTag, sibling);
  fake.forceTag(witnessTag, sibling);
  await assert.rejects(storeFor(fake, { ownerId: 'github:sibling' }).load(), /cloud_state_history_fork/);
});

test('established-v2 crash after state CAS but before status append is repair-only', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake);
  const n1 = await publishMarker(writer, 'n1');
  const snapshot = await writer.readSnapshot();
  fake.failNextStatusWrite(500);
  await assert.rejects(writer.writeSnapshot(blankState('n2'), snapshot), /cloud_state_partial_publication/);
  const n2 = fake.tagSha(stateTag);
  assert.notEqual(n1, n2);
  assert.equal((await writer.readStatusLedger()).at(-1).stateSha, n1);
  await assert.rejects(storeFor(fake, { ownerId: 'github:ahead:peek' }).load(), /cloud_state_partial_publication/);
  const repaired = await storeFor(fake, { ownerId: 'github:ahead:repair' }).readSnapshot({ repair: true });
  assert.equal(repaired.refSha, n2);
  assert.equal((await storeFor(fake, { ownerId: 'github:ahead:post' }).readStatusLedger()).at(-1).stateSha, n2);
});

test('duplicate identical status records are idempotent but conflicting duplicates fail closed', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const stateSha = await publishMarker(store, 'one');
  const envelope = fake.envelopeAt(stateSha);
  const context = store.ledgerContext(envelope.generation);
  const description = store.ledgerDescription(stateSha, envelope.lineageBaseSha);
  fake.forceStatus(context, description);
  assert.equal((await storeFor(fake, { ownerId: 'github:duplicate:ok' }).load()).marker, 'one');
  fake.forceStatus(context, store.ledgerDescription(fake.mainSha, envelope.lineageBaseSha));
  await assert.rejects(storeFor(fake, { ownerId: 'github:duplicate:bad' }).load(), /cloud_state_status_ledger_conflict/);
});

test('malformed status record for the lane fails closed', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  fake.forceStatus(store.ledgerContext(1), 'not-a-ledger-record');
  await assert.rejects(store.readStatusLedger(), /cloud_state_status_ledger_invalid/);
});

test('status ledger generation gap fails closed', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const n1 = fake.makeStateCommit({ generation: 1, state: blankState('n1') });
  const n2 = fake.makeStateCommit({ parentSha: n1, generation: 2, state: blankState('n2') });
  const n3 = fake.makeStateCommit({ parentSha: n2, generation: 3, state: blankState('n3') });
  installLedgerRecord(fake, store, 1, n1, fake.mainSha);
  installLedgerRecord(fake, store, 3, n3, n2);
  fake.forceTag(stateTag, n3);
  fake.forceTag(checkpointTag, n3);
  fake.forceTag(witnessTag, n3);
  await assert.rejects(storeFor(fake, { ownerId: 'github:gap' }).load(), /cloud_state_status_ledger_gap/);
});

test('two stale writers have one state-CAS winner and only that lineage gains status authority', async () => {
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
  assert.equal((await first.readStatusLedger()).at(-1).stateSha, winningSha);
});

test('checkpoint failure still attempts witness and immutable authority permits later repair', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake);
  const n1 = await publishMarker(writer, 'n1');
  const snapshot = await writer.readSnapshot();
  fake.failNextTagWrite(checkpointTag, 500);
  await assert.rejects(writer.writeSnapshot(blankState('n2'), snapshot), /cloud_state_partial_publication/);
  const n2 = fake.tagSha(stateTag);
  assert.notEqual(n2, n1);
  assert.equal(fake.tagSha(witnessTag), n2);
  assert.equal((await writer.readStatusLedger()).at(-1).stateSha, n2);
  await storeFor(fake, { ownerId: 'github:checkpoint:repair' }).readSnapshot({ repair: true });
  assert.equal(fake.tagSha(checkpointTag), n2);
});

test('witness failure leaves checkpoint and immutable authority for repair', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake);
  await publishMarker(writer, 'n1');
  const snapshot = await writer.readSnapshot();
  fake.failNextTagWrite(witnessTag, 500);
  await assert.rejects(writer.writeSnapshot(blankState('n2'), snapshot), /cloud_state_partial_publication/);
  const n2 = fake.tagSha(stateTag);
  assert.equal(fake.tagSha(checkpointTag), n2);
  assert.equal((await writer.readStatusLedger()).at(-1).stateSha, n2);
  await storeFor(fake, { ownerId: 'github:witness:repair' }).readSnapshot({ repair: true });
  assert.equal(fake.tagSha(witnessTag), n2);
});

test('batched lineage rejects hidden two-parent merge beneath authoritative head', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const n1 = await publishMarker(store, 'n1');
  const e1 = fake.envelopeAt(n1);
  const side = fake.makeStateCommit({ generation: 9, state: blankState('side'), version: 1 });
  const merge = fake.makeStateCommit({
    parentSha: n1,
    additionalParentShas: [side],
    generation: e1.generation + 1,
    state: blankState('merge'),
    lineageBaseSha: e1.lineageBaseSha,
    lineageBaseGeneration: e1.lineageBaseGeneration
  });
  const head = fake.makeStateCommit({
    parentSha: merge,
    generation: e1.generation + 2,
    state: blankState('head'),
    lineageBaseSha: e1.lineageBaseSha,
    lineageBaseGeneration: e1.lineageBaseGeneration
  });
  installLedgerRecord(fake, store, e1.generation + 1, merge, n1);
  installLedgerRecord(fake, store, e1.generation + 2, head, merge);
  fake.forceTag(stateTag, head);
  fake.forceTag(checkpointTag, head);
  fake.forceTag(witnessTag, head);
  await assert.rejects(storeFor(fake, { ownerId: 'github:hidden-merge' }).load(), /cloud_state_history_fork/);
});

test('batched lineage rejects malformed intermediate envelope', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const n1 = await publishMarker(store, 'n1');
  const e1 = fake.envelopeAt(n1);
  const bad = fake.makeStateCommit({
    parentSha: n1,
    generation: e1.generation + 1,
    state: blankState('bad'),
    lineageBaseSha: e1.lineageBaseSha,
    lineageBaseGeneration: e1.lineageBaseGeneration
  });
  fake.tamperEnvelope(bad, (envelope) => { envelope.stateHash = '0'.repeat(64); });
  const head = fake.makeStateCommit({
    parentSha: bad,
    generation: e1.generation + 2,
    state: blankState('head'),
    lineageBaseSha: e1.lineageBaseSha,
    lineageBaseGeneration: e1.lineageBaseGeneration
  });
  installLedgerRecord(fake, store, e1.generation + 1, bad, n1);
  installLedgerRecord(fake, store, e1.generation + 2, head, bad);
  fake.forceTag(stateTag, head);
  fake.forceTag(checkpointTag, head);
  fake.forceTag(witnessTag, head);
  await assert.rejects(storeFor(fake, { ownerId: 'github:bad-intermediate' }).load(), /cloud_state_integrity_mismatch/);
});

test('batched lineage rejects truncated state blobs', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const head = await publishMarker(store, 'head');
  fake.markHistoryTruncated(head);
  await assert.rejects(storeFor(fake, { ownerId: 'github:truncated' }).load(), /cloud_state_history_blob_invalid/);
});

test('v2 child cannot rewrite its inherited lineage anchor', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const n1 = await publishMarker(store, 'n1');
  const e1 = fake.envelopeAt(n1);
  const unrelated = fake.makeStateCommit({ generation: 7, state: blankState('legacy'), version: 1 });
  const bad = fake.makeStateCommit({
    parentSha: n1,
    generation: e1.generation + 1,
    state: blankState('rewrite'),
    lineageBaseSha: unrelated,
    lineageBaseGeneration: 7
  });
  installLedgerRecord(fake, store, e1.generation + 1, bad, n1);
  fake.forceTag(stateTag, bad);
  fake.forceTag(checkpointTag, bad);
  fake.forceTag(witnessTag, bad);
  await assert.rejects(storeFor(fake, { ownerId: 'github:anchor-rewrite' }).load(), /cloud_state_lineage_anchor|cloud_state_status_ledger/);
});

test('established 2050-generation v2 ledger and complete lineage validate below request cliff', async () => {
  const fake = fakeGitHub();
  const builder = storeFor(fake, { ownerId: 'github:deep:builder' });
  let parent = fake.mainSha;
  let head = null;
  for (let generation = 1; generation <= 2050; generation += 1) {
    head = fake.makeStateCommit({
      parentSha: parent,
      generation,
      state: blankState(`v2-${generation}`),
      lineageBaseSha: fake.mainSha,
      lineageBaseGeneration: 0
    });
    installLedgerRecord(fake, builder, generation, head, parent);
    parent = head;
  }
  fake.forceTag(stateTag, head);
  fake.forceTag(checkpointTag, head);
  fake.forceTag(witnessTag, head);
  fake.resetRequestCount();
  const loaded = await storeFor(fake, { ownerId: 'github:deep:fresh' }).load();
  assert.equal(loaded.marker, 'v2-2050');
  assert.ok(fake.requestCount() < 100, `expected batched ledger+lineage validation, received ${fake.requestCount()} requests`);
});

test('status ledger pagination tolerates unrelated statuses without weakening lane isolation', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const head = await publishMarker(store, 'one');
  for (let index = 0; index < 150; index += 1) {
    fake.forceStatus(`unrelated/${index}`, `noise-${index}`);
  }
  assert.equal((await storeFor(fake, { ownerId: 'github:pagination' }).load()).marker, 'one');
  assert.equal((await store.readStatusLedger()).at(-1).stateSha, head);
});

test('state content is always read by exact commit SHA', async () => {
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

test('remote envelope integrity mismatch fails closed even with matching status authority', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake, { ownerId: 'github:integrity' });
  const stateSha = await publishMarker(store, 'safe');
  fake.tamperEnvelope(stateSha, (envelope) => { envelope.stateHash = '0'.repeat(64); });
  await assert.rejects(storeFor(fake, { ownerId: 'github:integrity:fresh' }).load(), /cloud_state_integrity_mismatch/);
});
