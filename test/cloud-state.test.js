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

function deterministicGitCommitSha(body) {
  const author = body.author;
  const committer = body.committer ?? author;
  const toGitIdentity = (identity) => {
    const timestamp = Math.floor(Date.parse(identity.date) / 1000);
    if (!Number.isSafeInteger(timestamp)) throw new Error('invalid deterministic commit date');
    return `${identity.name} <${identity.email}> ${timestamp} +0000`;
  };
  const lines = [
    `tree ${body.tree}`,
    ...(body.parents ?? []).map((parent) => `parent ${parent}`),
    `author ${toGitIdentity(author)}`,
    `committer ${toGitIdentity(committer)}`,
    '',
    body.message
  ];
  const content = lines.join('\n');
  return createHash('sha1')
    .update(`commit ${Buffer.byteLength(content, 'utf8')}\0${content}`)
    .digest('hex');
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
  const statusesBySha = new Map();
  const truncatedBlobs = new Set();
  let precreateNextClaim = false;
  let loseNextClaimResponse = false;
  let claimCreateCount = 0;
  let moveMainAfterClaimAuthorityRead = null;
  let moveMainBeforeNextMainRead = null;
  let moveMainAfterNextCompare = null;
  let moveMainBeforeNextTagWrite = null;

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

  const statusContextPayload = (variables) => {
    const statuses = statusesBySha.get(variables.oid) ?? [];
    const wanted = String(variables.context ?? '').toLowerCase();
    const found = statuses.find((status) => String(status.context ?? '').toLowerCase() === wanted) ?? null;
    return {
      data: {
        repository: {
          object: {
            status: found ? {
              context: {
                context: found.context,
                state: String(found.state).toUpperCase(),
                description: found.description,
                targetUrl: found.target_url ?? null
              }
            } : null
          }
        }
      }
    };
  };

  const addStatus = (targetSha, { context, description, state = 'success', target_url = null }) => {
    const entry = {
      id: statusId++, state, description, target_url, context,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      creator: { login: 'github-actions[bot]', id: 1 }
    };
    const list = statusesBySha.get(targetSha) ?? [];
    list.unshift(entry);
    statusesBySha.set(targetSha, list);
    return entry;
  };

  const fetchImpl = async (rawUrl, options = {}) => {
    requestCount += 1;
    const url = new URL(rawUrl);
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : null;

    if (url.pathname === '/graphql') {
      assert.equal(method, 'POST');
      if (typeof body?.query === 'string' && body.query.includes('CloudStateContext')) {
        return response(200, statusContextPayload(body.variables));
      }
      return response(200, historyPayload(body.variables));
    }

    const prefix = '/repos/palgarra14-del/agente-automatizador';
    assert.ok(url.pathname.startsWith(prefix));
    const path = url.pathname.slice(prefix.length);
    if (method !== 'GET') writeCount += 1;
    const injected = maybeFail(method, path, body);
    if (injected) return injected;

    const statusGet = /^\/commits\/([a-f0-9]{40})\/statuses$/i.exec(path);
    if (method === 'GET' && statusGet) {
      const targetSha = statusGet[1].toLowerCase();
      if (moveMainAfterClaimAuthorityRead && claimCreateCount > moveMainAfterClaimAuthorityRead.claimCountAtArm) {
        refs.set('refs/heads/main', moveMainAfterClaimAuthorityRead.commitSha);
        moveMainAfterClaimAuthorityRead = null;
      }
      const perPage = Number(url.searchParams.get('per_page') ?? '30');
      const page = Number(url.searchParams.get('page') ?? '1');
      const start = (page - 1) * perPage;
      const statuses = statusesBySha.get(targetSha) ?? [];
      return response(200, statuses.slice(start, start + perPage).map(cloneState));
    }
    const statusPost = /^\/statuses\/([a-f0-9]{40})$/i.exec(path);
    if (method === 'POST' && statusPost) {
      const targetSha = statusPost[1].toLowerCase();
      statusWrites.push({ targetSha, ...cloneState(body) });
      return response(201, addStatus(targetSha, body));
    }
    if (method === 'GET' && path.startsWith('/git/ref/')) {
      const ref = `refs/${decodeURIComponent(path.slice('/git/ref/'.length))}`;
      if (ref === 'refs/heads/main' && moveMainBeforeNextMainRead) {
        refs.set(ref, moveMainBeforeNextMainRead);
        moveMainBeforeNextMainRead = null;
      }
      const value = refs.get(ref);
      return value ? response(200, { object: { sha: value } }) : response(404, { message: 'not found' });
    }
    if (method === 'GET' && path.startsWith('/git/commits/')) {
      const value = commits.get(path.slice('/git/commits/'.length));
      return value ? response(200, value) : response(404, {});
    }
    if (method === 'GET' && path.startsWith('/compare/')) {
      const [baseSha, headSha] = path.slice('/compare/'.length).split('...');
      const payload = comparePayload(baseSha, headSha);
      if (moveMainAfterNextCompare) {
        refs.set('refs/heads/main', moveMainAfterNextCompare);
        moveMainAfterNextCompare = null;
      }
      return response(200, payload);
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
      const id = body.author && body.committer ? deterministicGitCommitSha(body) : sha();
      commits.set(id, {
        sha: id,
        tree: { sha: body.tree },
        parents: (body.parents ?? []).map((parent) => ({ sha: parent })),
        ...(body.author ? { author: cloneState(body.author) } : {}),
        ...(body.committer ? { committer: cloneState(body.committer) } : {}),
        ...(typeof body.message === 'string' ? { message: body.message } : {})
      });
      return response(201, { sha: id });
    }
    if (method === 'POST' && path === '/git/refs') {
      refWrites.push({ method, path, body: cloneState(body) });
      if (moveMainBeforeNextTagWrite && typeof body?.ref === 'string' && body.ref.startsWith('refs/tags/')) {
        refs.set('refs/heads/main', moveMainBeforeNextTagWrite);
        moveMainBeforeNextTagWrite = null;
      }
      const isClaim = typeof body?.ref === 'string' && body.ref.startsWith('refs/tags/agent-cloud-state-v2-claims/');
      if (isClaim && precreateNextClaim) {
        precreateNextClaim = false;
        refs.set(body.ref, body.sha);
      }
      if (refs.has(body.ref)) return response(422, {});
      refs.set(body.ref, body.sha);
      if (isClaim) claimCreateCount += 1;
      if (isClaim && loseNextClaimResponse) {
        loseNextClaimResponse = false;
        return response(500, { message: 'response lost after create' });
      }
      return response(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if (method === 'PATCH' && path.startsWith('/git/refs/tags/')) {
      refWrites.push({ method, path, body: cloneState(body) });
      if (moveMainBeforeNextTagWrite) {
        refs.set('refs/heads/main', moveMainBeforeNextTagWrite);
        moveMainBeforeNextTagWrite = null;
      }
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

  const makeMetadataCommit = ({ previousStatusAnchorSha = null, message = null } = {}) => {
    const templateSha = previousStatusAnchorSha ?? LEDGER_ROOT_SHA;
    const template = commits.get(templateSha);
    assert.ok(template);
    const commitSha = sha();
    commits.set(commitSha, {
      sha: commitSha,
      tree: { sha: template.tree.sha },
      parents: previousStatusAnchorSha ? [{ sha: previousStatusAnchorSha }] : [],
      ...(message ? { message } : {})
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

  const failNextStatusWrite = (targetSha, status = 500, bodyMatch = () => true) => {
    failures.push({
      method: 'POST',
      status,
      match(path, body) {
        return path === `/statuses/${targetSha}` && bodyMatch(body);
      }
    });
  };

  const failNextAnyStatusWrite = (status = 500, bodyMatch = () => true) => {
    failures.push({
      method: 'POST',
      status,
      match(path, body) {
        return /^\/statuses\/[a-f0-9]{40}$/i.test(path) && bodyMatch(body);
      }
    });
  };

  const failNextClaimWrite = (status = 500) => {
    failures.push({
      method: 'POST',
      status,
      match(path, body) {
        return path === '/git/refs' &&
          typeof body?.ref === 'string' &&
          body.ref.startsWith('refs/tags/agent-cloud-state-v2-claims/');
      }
    });
  };

  const failNextMainRead = (status = 500) => {
    failures.push({
      method: 'GET',
      status,
      match(path) {
        return path === '/git/ref/heads/main';
      }
    });
  };

  return {
    fetchImpl,
    mainSha,
    makeStateCommit,
    makeMetadataCommit,
    tamperEnvelope,
    envelopeAt,
    aliasStatePath,
    failNextTagWrite,
    failNextStatusWrite,
    failNextAnyStatusWrite,
    failNextClaimWrite,
    failNextMainRead,
    precreateNextClaim() { precreateNextClaim = true; },
    loseNextClaimResponse() { loseNextClaimResponse = true; },
    moveMainAfterClaimAuthorityRead(commitSha) {
      assert.ok(commits.has(commitSha));
      moveMainAfterClaimAuthorityRead = { commitSha, claimCountAtArm: claimCreateCount };
    },
    moveMainAfterNextCompare(commitSha) {
      assert.ok(commits.has(commitSha));
      moveMainAfterNextCompare = commitSha;
    },
    moveMainBeforeNextTagWrite(commitSha) {
      assert.ok(commits.has(commitSha));
      moveMainBeforeNextTagWrite = commitSha;
    },
    moveMainBeforeNextMainRead(commitSha) {
      assert.ok(commits.has(commitSha));
      moveMainBeforeNextMainRead = commitSha;
    },
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
    forceStatus(targetSha, context, description, options = {}) {
      return addStatus(targetSha, { context, description, state: options.state ?? 'success', target_url: options.target_url ?? null });
    },
    statuses(targetSha = LEDGER_ROOT_SHA) { return (statusesBySha.get(targetSha) ?? []).map(cloneState); },
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
    },
    forceHead(branch, commitSha) {
      assert.ok(commits.has(commitSha));
      refs.set(`refs/heads/${branch}`, commitSha);
    },
    currentHead(branch) {
      return refs.get(`refs/heads/${branch}`) ?? null;
    },
    setCommitParents(commitSha, parentShas) {
      const commit = commits.get(commitSha);
      assert.ok(commit);
      commit.parents = parentShas.map((value) => ({ sha: value }));
    },
    setCommitMessage(commitSha, message) {
      const commit = commits.get(commitSha);
      assert.ok(commit);
      commit.message = message;
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

async function installRegistration(
  fake,
  store,
  epoch,
  stateAnchorSha,
  baseGeneration,
  startGeneration,
  previousRegistration = null,
  { linkPrevious = true } = {}
) {
  const previousStatusAnchorSha = previousRegistration?.statusAnchorSha ?? null;
  const statusAnchorSha = fake.makeMetadataCommit({
    previousStatusAnchorSha,
    message: store.epochMetadataMessage(epoch)
  });
  const authorityAnchorSha = fake.makeMetadataCommit({
    previousStatusAnchorSha: statusAnchorSha,
    message: store.epochAuthorityMessage(epoch)
  });
  fake.forceTag(store.epochAnchorTag(epoch), statusAnchorSha);
  fake.forceStatus(
    statusAnchorSha,
    store.epochRegistrationContext(),
    store.registrationDescription(
      epoch,
      stateAnchorSha,
      baseGeneration,
      startGeneration,
      authorityAnchorSha,
      previousStatusAnchorSha
    )
  );
  if (previousRegistration && linkPrevious) {
    fake.forceStatus(
      previousRegistration.statusAnchorSha,
      store.epochNextContext(),
      store.nextDescription(epoch, statusAnchorSha)
    );
  } else if (!previousRegistration) {
    const laneRoot = await store.laneRootCommit({ create: true });
    fake.forceStatus(
      laneRoot.sha,
      store.laneRootContext(),
      store.firstEpochDescription(epoch, statusAnchorSha)
    );
  }
  return {
    kind: 'registration',
    epoch,
    anchorSha: stateAnchorSha,
    baseGeneration,
    startGeneration,
    statusAnchorSha,
    authorityAnchorSha,
    previousStatusAnchorSha
  };
}

function installSeal(fake, store, registration, stateSha, generation, baseWitnessSha = fake.mainSha) {
  fake.forceStatus(
    registration.statusAnchorSha,
    store.epochSealContext(),
    store.sealDescription(stateSha, generation, baseWitnessSha)
  );
}

function installAuthority(fake, store, registration, generation, stateSha, parentSha, baseWitnessSha = fake.mainSha) {
  fake.forceStatus(
    registration.authorityAnchorSha,
    store.epochAuthorityContext(registration.epoch, generation),
    store.authorityDescription(stateSha, parentSha, baseWitnessSha)
  );
}

test('cloud state enforces explicit project ownership and secret boundaries', () => {
  assert.throws(() => validateCloudState({ runs: { r: { projectId: 'callflow' } }, approvals: {}, events: [] }), /ownership_mismatch/);
  assert.doesNotThrow(() => validateCloudState(
    { runs: { r: { projectId: 'website-pilot' } }, approvals: {}, events: [] },
    { allowedProjectIds: ['website-pilot'] }
  ));
  assert.throws(() => validateCloudState({ runs: {}, approvals: {}, events: [], apiToken: 'secret' }), /sensitive_key/);
});

test('generation claim namespace root cannot be used as a state tag', () => {
  const fake = fakeGitHub();
  assert.throws(() => storeFor(fake, { tag: 'agent-cloud-state-v2-claims' }), /tag_reserved/);
});

test('lane initialization marker is looked up by exact context and binds deterministic root', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  await publishMarker(store, 'one');
  const root = await store.laneRootCommit();
  assert.ok(root?.sha);
  const initStatuses = fake.statuses(LEDGER_ROOT_SHA).filter(
    (status) => status.context === store.laneInitContextName
  );
  assert.ok(initStatuses.length >= 1);
  assert.equal(initStatuses[0].description, store.laneInitDescription(root.sha));
});

test('initialized lane without first pointer fails closed instead of looking empty', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  fake.failNextAnyStatusWrite(500, (body) => body.context === store.laneRootContextName);
  await assert.rejects(() => publishMarker(store, 'never-published'), /lane_root_pointer_append_failed/);

  const fresh = storeFor(fake, { ownerId: 'github:2:1' });
  await assert.rejects(() => fresh.load(), /lane_initialized_incomplete/);
  await assert.rejects(() => fresh.readSnapshot({ repair: true }), /lane_initialized_incomplete/);
  assert.equal(fake.tagSha(stateTag), null);
});

test('conflicting latest lane-init marker fails closed', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  await publishMarker(store, 'one');
  fake.forceStatus(
    LEDGER_ROOT_SHA,
    store.laneInitContextName,
    store.laneInitDescription('f'.repeat(40))
  );
  await assert.rejects(() => storeFor(fake, { ownerId: 'github:2:1' }).load(), /lane_init_conflict/);
});

test('epoch authority is anchored to the verified parentless repository root', async () => {
  const fake = fakeGitHub();
  fake.setRootParents([fake.mainSha]);
  const store = storeFor(fake);
  await assert.rejects(() => store.readSnapshot(), /status_root_invalid/);
});

test('bootstrap registers epoch, atomically claims generation, then writes canonical authority', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const sha = await publishMarker(store, 'one');
  const envelope = fake.envelopeAt(sha);
  assert.equal(envelope.generation, 1);
  const registration = (await store.readRootEvidence()).registrationByEpoch.get(0);
  const anchorContexts = fake.statuses(registration.statusAnchorSha).map((status) => status.context);
  assert.ok(anchorContexts.includes(store.epochRegistrationContext()));
  assert.ok(!anchorContexts.some((context) => context.includes('/i/')));
  assert.ok(fake.refWrites().some((write) =>
    write.method === 'POST' &&
    typeof write.body?.ref === 'string' &&
    write.body.ref.startsWith('refs/tags/agent-cloud-state-v2-claims/')
  ));
  const authorities = fake.statuses(registration.authorityAnchorSha);
  assert.ok(authorities.some((status) => status.context === store.epochAuthorityContext(0, 1)));
  assert.equal(fake.tagSha(stateTag), sha);
  assert.equal(fake.tagSha(checkpointTag), sha);
  assert.equal(fake.tagSha(witnessTag), sha);
});

test('fresh load of aligned r6 state is read-only', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake);
  await publishMarker(writer, 'one');
  fake.resetWriteCount();
  const fresh = storeFor(fake, { ownerId: 'github:2:1' });
  const loaded = await fresh.load();
  assert.equal(loaded.marker, 'one');
  assert.equal(fake.writeCount(), 0);
});

test('orphan bootstrap registration remains reusable when main advances', async () => {
  const fake = fakeGitHub();
  const firstAttempt = storeFor(fake);
  fake.failNextClaimWrite(500);
  await assert.rejects(() => publishMarker(firstAttempt, 'failed'), /generation_election_failed/);
  const root = await firstAttempt.readRootEvidence();
  const registeredAnchor = root.registrations[0].anchorSha;

  const advancedMain = fake.makeStateCommit({
    parentSha: fake.mainSha,
    generation: 900,
    state: blankState('main-advanced'),
    lineageBaseSha: fake.mainSha,
    lineageBaseGeneration: 0
  });
  fake.forceHead('main', advancedMain);

  const fresh = storeFor(fake, { ownerId: 'github:2:1' });
  assert.equal((await fresh.load()).marker, undefined);
  const published = await publishMarker(fresh, 'reused-anchor');
  assert.equal(fake.envelopeAt(published).lineageBaseSha, registeredAnchor);
  assert.equal((await storeFor(fake, { ownerId: 'github:3:1' }).load()).marker, 'reused-anchor');
});

test('cached lineage cannot publish after base branch ancestry changes between load and save', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  await publishMarker(store, 'one');

  const snapshot = await store.readSnapshot();
  const state = cloneState(snapshot.state);
  state.marker = 'two';

  const divergentMain = fake.makeMetadataCommit({ message: 'divergent main' });
  fake.forceHead('main', divergentMain);

  await assert.rejects(() => store.writeSnapshot(state, snapshot), /bootstrap_ancestry_invalid/);
  assert.equal(fake.tagSha(store.generationClaimTag(2)), null);

  const root = await store.readRootEvidence();
  const registration = root.registrationByEpoch.get(0);
  const authorities = await store.readEpochAuthorities(registration);
  assert.equal(authorities.length, 1);
  assert.equal(authorities[0].generation, 1);
});

test('canonical authority publication revalidates base after the final authority scan', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const first = await publishMarker(store, 'one');
  const snapshot = await store.readSnapshot();
  const nextState = cloneState(snapshot.state);
  nextState.marker = 'two';

  const divergentMain = fake.makeMetadataCommit({ message: 'divergent main after claim scan' });
  fake.moveMainAfterClaimAuthorityRead(divergentMain);

  await assert.rejects(
    () => store.writeSnapshot(nextState, snapshot),
    (error) => error?.message === 'cloud_state_partial_publication' &&
      error?.cause?.message === 'cloud_state_bootstrap_ancestry_invalid'
  );

  assert.equal(fake.tagSha(stateTag), first);
  const root = await store.readRootEvidence();
  const registration = root.registrationByEpoch.get(0);
  const authorities = await store.readEpochAuthorities(registration);
  assert.equal(authorities.length, 1);
  assert.equal(authorities[0].generation, 1);
});

test('sealed fallback authority stays bound to its immutable base witness after main moves', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const epoch0 = await installRegistration(fake, store, 0, fake.mainSha, 0, 1);
  const sealedSha = fake.makeStateCommit({
    parentSha: fake.mainSha,
    generation: 256,
    state: blankState('sealed'),
    lineageBaseSha: fake.mainSha,
    lineageBaseGeneration: 0
  });
  installSeal(fake, store, epoch0, sealedSha, 256, fake.mainSha);
  await installRegistration(fake, store, 1, sealedSha, 256, 257, epoch0);
  fake.forceTag(stateTag, sealedSha);
  fake.forceTag(checkpointTag, sealedSha);
  fake.forceTag(witnessTag, sealedSha);

  const divergentMain = fake.makeMetadataCommit({ message: 'divergent main' });
  fake.forceHead('main', divergentMain);

  const loaded = await storeFor(fake, { ownerId: 'github:2:1' }).load();
  assert.equal(loaded.marker, 'sealed');
});

test('sealed fallback repair is stable when main moves after witness validation', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const epoch0 = await installRegistration(fake, store, 0, fake.mainSha, 0, 1);
  const sealedSha = fake.makeStateCommit({
    parentSha: fake.mainSha,
    generation: 256,
    state: blankState('sealed'),
    lineageBaseSha: fake.mainSha,
    lineageBaseGeneration: 0
  });
  installSeal(fake, store, epoch0, sealedSha, 256, fake.mainSha);
  await installRegistration(fake, store, 1, sealedSha, 256, 257, epoch0);
  fake.forceTag(stateTag, sealedSha);
  fake.forceTag(checkpointTag, sealedSha);
  fake.deleteTag(witnessTag);

  const divergentMain = fake.makeMetadataCommit({ message: 'divergent main at ref-repair boundary' });
  fake.moveMainBeforeNextTagWrite(divergentMain);

  const fresh = storeFor(fake, { ownerId: 'github:2:1' });
  const repaired = await fresh.readSnapshot({ repair: true });
  assert.equal(repaired.state.marker, 'sealed');
  assert.equal(fake.tagSha(witnessTag), sealedSha);
  assert.equal(fake.currentHead('main'), divergentMain);
});

test('next-link repair is bound to the sealed base witness, not the later mutable main', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const epoch0 = await installRegistration(fake, store, 0, fake.mainSha, 0, 1);
  const sealedSha = fake.makeStateCommit({
    parentSha: fake.mainSha,
    generation: 256,
    state: blankState('sealed'),
    lineageBaseSha: fake.mainSha,
    lineageBaseGeneration: 0
  });
  installSeal(fake, store, epoch0, sealedSha, 256, fake.mainSha);
  await installRegistration(fake, store, 1, sealedSha, 256, 257, epoch0, { linkPrevious: false });
  for (const tag of [stateTag, checkpointTag, witnessTag]) fake.forceTag(tag, sealedSha);

  const divergentMain = fake.makeMetadataCommit({ message: 'divergent main before next repair' });
  fake.forceHead('main', divergentMain);

  const fresh = storeFor(fake, { ownerId: 'github:2:1' });
  const repaired = await fresh.readSnapshot({ repair: true });
  assert.equal(repaired.state.marker, 'sealed');
  assert.equal(
    fake.statuses(epoch0.statusAnchorSha).filter((status) => status.context === fresh.epochNextContextName).length,
    1
  );
  assert.equal(fake.tagSha(fresh.generationClaimTag(257)), null);
});

test('next-link repair rejects a forged sealed base witness', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const epoch0 = await installRegistration(fake, store, 0, fake.mainSha, 0, 1);
  const sealedSha = fake.makeStateCommit({
    parentSha: fake.mainSha,
    generation: 256,
    state: blankState('sealed'),
    lineageBaseSha: fake.mainSha,
    lineageBaseGeneration: 0
  });
  const divergentWitness = fake.makeMetadataCommit({ message: 'forged base witness' });
  installSeal(fake, store, epoch0, sealedSha, 256, divergentWitness);
  await installRegistration(fake, store, 1, sealedSha, 256, 257, epoch0, { linkPrevious: false });
  for (const tag of [stateTag, checkpointTag, witnessTag]) fake.forceTag(tag, sealedSha);

  const fresh = storeFor(fake, { ownerId: 'github:2:1' });
  await assert.rejects(() => fresh.readSnapshot({ repair: true }), /bootstrap_ancestry_invalid/);
  assert.equal(
    fake.statuses(epoch0.statusAnchorSha).filter((status) => status.context === fresh.epochNextContextName).length,
    0
  );
  assert.equal(fake.tagSha(fresh.generationClaimTag(257)), null);
});

test('legacy migration preserves inherited generation offsets', async () => {
  const fake = fakeGitHub();
  const legacy = fake.makeStateCommit({ generation: 280, state: blankState('legacy'), version: 1 });
  fake.forceTag(stateTag, legacy);
  const store = storeFor(fake);
  const next = await publishMarker(store, 'migrated');
  const envelope = fake.envelopeAt(next);
  assert.equal(envelope.generation, 281);
  assert.equal(envelope.lineageBaseSha, legacy);
  assert.equal(envelope.lineageBaseGeneration, 280);
  const root = await store.readRootEvidence();
  const registration = root.registrationByEpoch.get(1);
  assert.equal(registration.anchorSha, legacy);
  assert.equal(registration.baseGeneration, 280);
  assert.equal(registration.startGeneration, 281);
});

test('legacy generation offset does not depend on Git distance', async () => {
  const fake = fakeGitHub();
  const legacy1 = fake.makeStateCommit({ generation: 4, state: blankState('g4'), version: 1 });
  const legacy2 = fake.makeStateCommit({ parentSha: legacy1, generation: 5, state: blankState('g5'), version: 1 });
  fake.forceTag(stateTag, legacy2);
  const store = storeFor(fake);
  const next = await publishMarker(store, 'g6');
  assert.equal(fake.envelopeAt(next).generation, 6);
  assert.equal((await storeFor(fake, { ownerId: 'github:2:1' }).load()).marker, 'g6');
});

test('a contents-writer precreating the exact claim cannot be mistaken for election success', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  fake.precreateNextClaim();
  await assert.rejects(() => publishMarker(store, 'never-authoritative'), /generation_election_failed/);
  const root = await store.readRootEvidence();
  assert.equal(root.registrations.length, 1);
  assert.equal((await store.readEpochAuthorities(root.registrations[0])).length, 0);
  assert.equal(fake.tagSha(stateTag), null);
});

test('a lost claim-create response never becomes authority by rereading the claim', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  fake.loseNextClaimResponse();
  await assert.rejects(() => publishMarker(store, 'uncertain-claim'), /generation_election_failed/);
  const root = await store.readRootEvidence();
  assert.equal((await store.readEpochAuthorities(root.registrations[0])).length, 0);
  assert.equal(fake.tagSha(stateTag), null);
  const fresh = storeFor(fake, { ownerId: 'github:2:1' });
  assert.equal((await fresh.load()).marker, undefined);
  await assert.rejects(() => publishMarker(fresh, 'retry-blocked'), /generation_election_failed/);
});

test('bootstrap crash after claim but before authority leaves no state authority and cannot auto-recover', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  fake.failNextAnyStatusWrite(500, (body) => body.context.includes('/g/'));
  await assert.rejects(() => publishMarker(store, 'uncertain'), /partial_publication/);
  assert.equal(fake.tagSha(stateTag), null);
  const fresh = storeFor(fake, { ownerId: 'github:2:1' });
  assert.equal((await fresh.load()).marker, undefined);
  assert.equal((await fresh.readSnapshot({ repair: true })).authoritySha, null);
  await assert.rejects(() => publishMarker(fresh, 'retry-blocked'), /generation_election_failed/);
});

test('established crash after claim but before authority leaves the prior authority intact', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const first = await publishMarker(store, 'one');
  fake.failNextAnyStatusWrite(500, (body) => body.context.endsWith('/0/2'));
  await assert.rejects(() => publishMarker(store, 'two'), /partial_publication/);
  assert.equal(fake.tagSha(stateTag), first);
  const fresh = storeFor(fake, { ownerId: 'github:2:1' });
  assert.equal((await fresh.load()).marker, 'one');
  await assert.rejects(() => publishMarker(fresh, 'retry-blocked'), /generation_election_failed/);
});

test('state-ref publication failure after authority is recoverable from canonical authority', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  fake.failNextTagWrite(stateTag, 500);
  await assert.rejects(() => publishMarker(store, 'authoritative'), /partial_publication/);
  assert.equal(fake.tagSha(stateTag), null);
  const fresh = storeFor(fake, { ownerId: 'github:2:1' });
  await assert.rejects(() => fresh.readSnapshot(), /rollback/);
  const repaired = await fresh.readSnapshot({ repair: true });
  assert.equal(repaired.state.marker, 'authoritative');
  assert.equal(fake.tagSha(stateTag), repaired.authoritySha);
});

test('checkpoint failure occurs only after authority and later governed repair completes it', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  fake.failNextTagWrite(checkpointTag, 500);
  await assert.rejects(() => publishMarker(store, 'one'), /partial_publication/);
  const authoritative = fake.tagSha(stateTag);
  assert.ok(authoritative);
  assert.equal(fake.tagSha(witnessTag), authoritative);
  const fresh = storeFor(fake, { ownerId: 'github:2:1' });
  const repaired = await fresh.readSnapshot({ repair: true });
  assert.equal(repaired.authoritySha, authoritative);
  assert.equal(fake.tagSha(checkpointTag), authoritative);
});

test('witness failure leaves durable authority for later repair', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  fake.failNextTagWrite(witnessTag, 500);
  await assert.rejects(() => publishMarker(store, 'one'), /partial_publication/);
  const authoritative = fake.tagSha(stateTag);
  const fresh = storeFor(fake, { ownerId: 'github:2:1' });
  await fresh.readSnapshot({ repair: true });
  assert.equal(fake.tagSha(witnessTag), authoritative);
});

test('fresh process rejects joint rollback of all movable refs and repair moves only forward', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const first = await publishMarker(store, 'one');
  const second = await publishMarker(store, 'two');
  for (const tag of [stateTag, checkpointTag, witnessTag]) fake.forceTag(tag, first);
  const fresh = storeFor(fake, { ownerId: 'github:2:1' });
  await assert.rejects(() => fresh.readSnapshot(), /rollback/);
  const repaired = await fresh.readSnapshot({ repair: true });
  assert.equal(repaired.authoritySha, second);
  for (const tag of [stateTag, checkpointTag, witnessTag]) assert.equal(fake.tagSha(tag), second);
});

test('same-generation sibling is rejected even when all mutable refs point to it', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const first = await publishMarker(store, 'one');
  const sibling = fake.makeStateCommit({
    parentSha: fake.mainSha,
    generation: 1,
    state: blankState('sibling'),
    lineageBaseSha: fake.mainSha,
    lineageBaseGeneration: 0
  });
  for (const tag of [stateTag, checkpointTag, witnessTag]) fake.forceTag(tag, sibling);
  const fresh = storeFor(fake, { ownerId: 'github:2:1' });
  await assert.rejects(() => fresh.readSnapshot({ repair: true }), /history_fork/);
  assert.notEqual(first, sibling);
});

test('contents-only direct child ahead of authority cannot be promoted by repair', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const first = await publishMarker(store, 'one');
  const child = fake.makeStateCommit({
    parentSha: first,
    generation: 2,
    state: blankState('contents-only'),
    lineageBaseSha: fake.mainSha,
    lineageBaseGeneration: 0
  });
  fake.forceTag(stateTag, child);
  const fresh = storeFor(fake, { ownerId: 'github:2:1' });
  await assert.rejects(() => fresh.readSnapshot(), /unproven_state_advance/);
  await assert.rejects(() => fresh.readSnapshot({ repair: true }), /unproven_state_advance/);
});

test('two stale writers yield exactly one canonical winner', async () => {
  const fake = fakeGitHub();
  const a = storeFor(fake, { ownerId: 'github:1:1' });
  const b = storeFor(fake, { ownerId: 'github:2:1' });
  const snapA = await a.readSnapshot();
  const snapB = await b.readSnapshot();
  const stateA = cloneState(snapA.state); stateA.marker = 'a';
  const stateB = cloneState(snapB.state); stateB.marker = 'b';
  const results = await Promise.allSettled([
    a.writeSnapshot(stateA, snapA),
    b.writeSnapshot(stateB, snapB)
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  const fresh = storeFor(fake, { ownerId: 'github:3:1' });
  assert.ok(['a', 'b'].includes((await fresh.load()).marker));
});

test('conflicting canonical status for one generation fails closed', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const first = await publishMarker(store, 'one');
  const root = await store.readRootEvidence();
  const registration = root.registrations[0];
  fake.forceStatus(
    registration.authorityAnchorSha,
    store.epochAuthorityContext(registration.epoch, 1),
    store.authorityDescription('f'.repeat(40), registration.anchorSha, fake.mainSha)
  );
  await assert.rejects(() => storeFor(fake, { ownerId: 'github:2:1' }).load(), /authority_conflict/);
  assert.ok(first);
});

test('conflicting epoch registration fails closed', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  await publishMarker(store, 'one');
  fake.forceStatus(
    (await store.readRootEvidence()).registrationByEpoch.get(0).statusAnchorSha,
    store.epochRegistrationContext(),
    store.registrationDescription(
      0,
      'f'.repeat(40),
      0,
      1,
      (await store.readRootEvidence()).registrationByEpoch.get(0).authorityAnchorSha,
      null
    )
  );
  await assert.rejects(() => storeFor(fake, { ownerId: 'github:2:1' }).load(), /registration_conflict/);
});

test('epoch anchor Git identities bind lane and epoch and reject cross-lane transplant', async () => {
  const fake = fakeGitHub();
  const selfStore = storeFor(fake);
  const websiteStore = storeFor(fake, {
    ownerId: 'github:2:1',
    laneId: 'website-pilot',
    allowedProjectIds: ['website-pilot'],
    tag: 'agent-cloud-state-website-pilot-v1',
    statePath: '.agent/cloud-state-website-pilot.json'
  });

  assert.notEqual(selfStore.epochMetadataMessage(0), websiteStore.epochMetadataMessage(0));
  assert.notEqual(selfStore.epochAuthorityMessage(0), websiteStore.epochAuthorityMessage(0));
  assert.notEqual(selfStore.epochMetadataMessage(0), selfStore.epochMetadataMessage(1));

  const registration = await installRegistration(fake, selfStore, 0, fake.mainSha, 0, 1);
  fake.setCommitMessage(registration.statusAnchorSha, websiteStore.epochMetadataMessage(0));
  await assert.rejects(
    () => storeFor(fake, { ownerId: 'github:3:1' }).readRootEvidence(),
    /epoch_anchor_identity_invalid/
  );
});

test('authority anchor Git identity is verified independently of its parent binding', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const registration = await installRegistration(fake, store, 0, fake.mainSha, 0, 1);
  fake.setCommitMessage(registration.authorityAnchorSha, 'foreign authority anchor');
  await assert.rejects(() => store.readEpochAuthorities(registration), /authority_anchor_identity_invalid/);
});

test('epoch rollover seals the completed epoch and starts a bounded next epoch', async () => {
  const fake = fakeGitHub();
  const legacy = fake.makeStateCommit({ generation: 255, state: blankState('legacy'), version: 1 });
  fake.forceTag(stateTag, legacy);
  const store = storeFor(fake);
  const g256 = await publishMarker(store, 'g256');
  const g257 = await publishMarker(store, 'g257');
  const root = await store.readRootEvidence();
  assert.equal(root.registrations.length, 2);
  assert.equal(root.registrations[0].epoch, 0);
  assert.equal(root.registrations[0].startGeneration, 256);
  assert.equal(root.seals.get(0).stateSha, g256);
  assert.equal(root.seals.get(0).generation, 256);
  assert.equal(root.registrations[1].epoch, 1);
  assert.equal(root.registrations[1].anchorSha, g256);
  assert.equal(root.registrations[1].startGeneration, 257);
  assert.equal((await storeFor(fake, { ownerId: 'github:2:1' }).load()).marker, 'g257');
  assert.equal(fake.envelopeAt(g257).generation, 257);
});

test('missing immutable next link blocks authority until governed repair verifies it', async () => {
  const fake = fakeGitHub();
  const legacy = fake.makeStateCommit({ generation: 255, state: blankState('legacy'), version: 1 });
  fake.forceTag(stateTag, legacy);
  const store = storeFor(fake);
  const g256 = await publishMarker(store, 'g256');

  fake.failNextAnyStatusWrite(500, (body) => body.context === store.epochNextContextName);
  await assert.rejects(() => publishMarker(store, 'g257-crash'), /epoch_next_append_failed/);
  assert.equal(fake.tagSha(stateTag), g256);
  assert.equal(fake.tagSha(store.generationClaimTag(257)), null);

  const fresh = storeFor(fake, { ownerId: 'github:2:1' });
  await assert.rejects(() => fresh.load(), /epoch_next_missing/);

  const repaired = await fresh.readSnapshot({ repair: true });
  assert.equal(repaired.state.marker, 'g256');

  const rootAfterRepair = await fresh.readRootEvidence();
  assert.equal(rootAfterRepair.registrations.length, 2);
  const firstRegistration = rootAfterRepair.registrations[0];
  const nextStatuses = fake.statuses(firstRegistration.statusAnchorSha).filter(
    (status) => status.context === fresh.epochNextContextName
  );
  assert.equal(nextStatuses.length, 1);

  const g257 = await publishMarker(fresh, 'g257');
  assert.equal(fake.envelopeAt(g257).generation, 257);
});

test('orphan next-epoch registration before generation claim is harmless and reusable', async () => {
  const fake = fakeGitHub();
  const legacy = fake.makeStateCommit({ generation: 255, state: blankState('legacy'), version: 1 });
  fake.forceTag(stateTag, legacy);
  const store = storeFor(fake);
  const g256 = await publishMarker(store, 'g256');
  fake.failNextClaimWrite(500);
  await assert.rejects(() => publishMarker(store, 'failed-g257'), /generation_election_failed/);
  const rootAfterFailure = await store.readRootEvidence();
  assert.ok(rootAfterFailure.seals.has(0));
  assert.ok(rootAfterFailure.registrationByEpoch.has(1));
  assert.equal(fake.tagSha(stateTag), g256);
  const fresh = storeFor(fake, { ownerId: 'github:2:1' });
  assert.equal((await fresh.load()).marker, 'g256');
  const g257 = await publishMarker(fresh, 'g257');
  assert.equal(fake.envelopeAt(g257).generation, 257);
});

test('active epoch rejects hidden two-parent merge beneath authoritative head', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const first = await publishMarker(store, 'one');
  const second = await publishMarker(store, 'two');
  fake.setCommitParents(second, [first, fake.mainSha]);
  await assert.rejects(() => storeFor(fake, { ownerId: 'github:2:1' }).load(), /history_fork/);
});

test('active epoch rejects malformed intermediate envelope', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const first = await publishMarker(store, 'one');
  await publishMarker(store, 'two');
  const third = await publishMarker(store, 'three');
  fake.tamperEnvelope(first, (envelope) => { envelope.generation = 99; });
  await assert.rejects(() => storeFor(fake, { ownerId: 'github:2:1' }).load(), /generation_discontinuity|integrity_mismatch/);
  assert.ok(third);
});

test('active epoch rejects truncated history blobs', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const first = await publishMarker(store, 'one');
  await publishMarker(store, 'two');
  fake.markHistoryTruncated(first);
  await assert.rejects(() => storeFor(fake, { ownerId: 'github:2:1' }).load(), /history_blob_invalid/);
});

test('v2 child cannot rewrite inherited lineage anchor', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  await publishMarker(store, 'one');
  const second = await publishMarker(store, 'two');
  fake.tamperEnvelope(second, (envelope) => {
    envelope.lineageBaseSha = 'f'.repeat(40);
    envelope.stateHash = hashState(envelope.state);
  });
  await assert.rejects(() => storeFor(fake, { ownerId: 'github:2:1' }).load(), /lineage_anchor_mismatch|lineage_anchor_invalid/);
});

test('independent lanes use disjoint epoch status contexts', async () => {
  const fake = fakeGitHub();
  const selfStore = storeFor(fake);
  const websiteTag = 'agent-cloud-state-website-pilot-v1';
  const websiteStore = storeFor(fake, {
    ownerId: 'github:2:1',
    laneId: 'website-pilot',
    allowedProjectIds: ['website-pilot'],
    tag: websiteTag,
    statePath: '.agent/cloud-state-website-pilot.json'
  });
  const selfState = cloneState((await selfStore.readSnapshot()).state); selfState.marker = 'self';
  await selfStore.writeSnapshot(selfState, await selfStore.readSnapshot());
  const websiteSnap = await websiteStore.readSnapshot();
  const websiteState = cloneState(websiteSnap.state); websiteState.marker = 'website';
  await websiteStore.writeSnapshot(websiteState, websiteSnap);
  assert.notEqual(selfStore.epochRegistrationContext(0), websiteStore.epochRegistrationContext(0));
  assert.equal((await storeFor(fake, { ownerId: 'github:3:1' }).load()).marker, 'self');
  assert.equal((await storeFor(fake, {
    ownerId: 'github:4:1',
    laneId: 'website-pilot',
    allowedProjectIds: ['website-pilot'],
    tag: websiteTag,
    statePath: '.agent/cloud-state-website-pilot.json'
  }).load()).marker, 'website');
});

test('same-lane authority status for a different epoch on the active anchor fails closed', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  await publishMarker(store, 'one');
  fake.forceStatus(
    (await store.readRootEvidence()).registrationByEpoch.get(0).authorityAnchorSha,
    store.epochAuthorityContext(1, 257),
    store.authorityDescription('f'.repeat(40), fake.mainSha, fake.mainSha)
  );
  await assert.rejects(() => storeFor(fake, { ownerId: 'github:2:1' }).load(), /epoch_authority_invalid|epoch_authority_gap/);
});

test('sealed historical metadata remains one-page even when authority anchor is full', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const registration = await installRegistration(fake, store, 0, fake.mainSha, 0, 1);
  let parentSha = fake.mainSha;
  for (let generation = 1; generation <= 256; generation += 1) {
    const commitSha = fake.makeStateCommit({
      parentSha,
      generation,
      state: blankState(`g${generation}`),
      lineageBaseSha: fake.mainSha,
      lineageBaseGeneration: 0
    });
    installAuthority(fake, store, registration, generation, commitSha, parentSha);
    parentSha = commitSha;
  }
  installSeal(fake, store, registration, parentSha, 256);
  fake.resetRequestCount();
  const root = await store.readRootEvidence();
  assert.equal(root.seals.get(0).generation, 256);
  assert.ok(fake.requestCount() < 10, `historical metadata should not scan 256 authority statuses; got ${fake.requestCount()}`);
});

test('status pagination tolerates unrelated contexts on this lane epoch anchor', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const registration = await installRegistration(fake, store, 0, fake.mainSha, 0, 1);
  for (let index = 0; index < 150; index += 1) {
    fake.forceStatus(registration.authorityAnchorSha, `unrelated/${index}`, 'not-cloud-state');
  }
  const snapshot = await store.readSnapshot();
  const state = cloneState(snapshot.state);
  state.marker = 'one';
  await store.writeSnapshot(state, snapshot);
  assert.equal((await storeFor(fake, { ownerId: 'github:2:1' }).load()).marker, 'one');
});

test('active epoch status scan has an explicit fail-closed page bound', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const registration = await installRegistration(fake, store, 0, fake.mainSha, 0, 1);
  for (let index = 0; index < 800; index += 1) {
    fake.forceStatus(registration.authorityAnchorSha, `unrelated/${index}`, 'not-cloud-state');
  }
  await assert.rejects(() => store.readSnapshot(), /epoch_status_limit/);
});

test('deleting every mutable lane ref cannot erase deterministic lane-root authority', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const first = await publishMarker(store, 'one');
  const second = await publishMarker(store, 'two');
  const root = await store.readRootEvidence();
  const registration = root.registrations[0];

  for (const tag of [
    stateTag,
    checkpointTag,
    witnessTag,
    store.epochAnchorTag(0),
    store.generationClaimTag(1),
    store.generationClaimTag(2)
  ]) {
    fake.deleteTag(tag);
  }

  const fresh = storeFor(fake, { ownerId: 'github:2:1' });
  await assert.rejects(() => fresh.readSnapshot(), /rollback/);
  const repaired = await fresh.readSnapshot({ repair: true });
  assert.equal(repaired.authoritySha, second);
  assert.equal(repaired.state.marker, 'two');
  assert.equal(fake.tagSha(stateTag), second);
  assert.equal(registration.anchorSha, fake.mainSha);
  assert.notEqual(first, second);
});

test('more than 2000 unrelated repository-root statuses cannot exhaust this lane', async () => {
  const fake = fakeGitHub();
  for (let index = 0; index < 2200; index += 1) {
    fake.forceStatus(LEDGER_ROOT_SHA, `other-lane/${index}`, 'unrelated');
  }
  const store = storeFor(fake);
  const first = await publishMarker(store, 'g1');
  assert.equal(fake.envelopeAt(first).generation, 1);
  assert.equal((await storeFor(fake, { ownerId: 'github:2:1' }).load()).marker, 'g1');

  const legacy = fakeGitHub();
  for (let index = 0; index < 2200; index += 1) {
    legacy.forceStatus(LEDGER_ROOT_SHA, `other-lane/${index}`, 'unrelated');
  }
  const legacyHead = legacy.makeStateCommit({ generation: 255, state: blankState('legacy'), version: 1 });
  legacy.forceTag(stateTag, legacyHead);
  const rolloverStore = storeFor(legacy);
  const g256 = await publishMarker(rolloverStore, 'g256');
  const g257 = await publishMarker(rolloverStore, 'g257');
  assert.equal(legacy.envelopeAt(g256).generation, 256);
  assert.equal(legacy.envelopeAt(g257).generation, 257);
  assert.equal((await storeFor(legacy, { ownerId: 'github:3:1' }).load()).marker, 'g257');
});

test('2050-generation segmented history validates with lane-isolated bounded requests', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  let parentSha = fake.mainSha;
  let registration = null;
  let previousRegistration = null;
  let lastSha = null;
  for (let generation = 1; generation <= 2050; generation += 1) {
    const epoch = Math.floor((generation - 1) / 256);
    if (generation === 1 || (generation - 1) % 256 === 0) {
      registration = await installRegistration(
        fake,
        store,
        epoch,
        parentSha,
        generation - 1,
        generation,
        previousRegistration
      );
      previousRegistration = registration;
    }
    const commitSha = fake.makeStateCommit({
      parentSha,
      generation,
      state: blankState(`g${generation}`),
      lineageBaseSha: fake.mainSha,
      lineageBaseGeneration: 0
    });
    installAuthority(fake, store, registration, generation, commitSha, parentSha);
    parentSha = commitSha;
    lastSha = commitSha;
    if (generation % 256 === 0) installSeal(fake, store, registration, commitSha, generation);
  }
  for (const tag of [stateTag, checkpointTag, witnessTag]) fake.forceTag(tag, lastSha);
  fake.resetRequestCount();
  const fresh = storeFor(fake, { ownerId: 'github:2:1' });
  const loaded = await fresh.load();
  assert.equal(loaded.marker, 'g2050');
  assert.ok(fake.requestCount() < 60, `expected bounded epoch validation, received ${fake.requestCount()} requests`);

  fake.resetRequestCount();
  const next = await publishMarker(fresh, 'g2051');
  assert.equal(fake.envelopeAt(next).generation, 2051);
  assert.ok(fake.requestCount() < 90, `expected bounded long-history write, received ${fake.requestCount()} requests`);
});

test('state content is always read by exact commit SHA', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const sha = await publishMarker(store, 'one');
  fake.clearContentRefs();
  await storeFor(fake, { ownerId: 'github:2:1' }).load();
  assert.ok(fake.contentRefs().length > 0);
  assert.ok(fake.contentRefs().every((ref) => /^[a-f0-9]{40}$/i.test(ref)));
  assert.ok(fake.contentRefs().includes(sha));
});

test('global lease excludes concurrent runners and recovers after expiry', async () => {
  let now = Date.parse('2026-09-17T00:00:00Z');
  const fake = fakeGitHub();
  const first = storeFor(fake, { ownerId: 'github:1:1', now: () => now, leaseTtlMs: 60_000 });
  const second = storeFor(fake, { ownerId: 'github:2:1', now: () => now, leaseTtlMs: 60_000 });
  const lease = await first.claimGlobalLease();
  await assert.rejects(() => second.claimGlobalLease(), /global_lease_busy/);
  now += 61_000;
  const recovered = await second.claimGlobalLease();
  assert.notEqual(recovered.leaseId, lease.leaseId);
});

test('execution leases use cloud owner identity and become recoverable only after ttl by another owner', async () => {
  let now = Date.parse('2026-09-17T00:00:00Z');
  const fake = fakeGitHub();
  const owner = storeFor(fake, { ownerId: 'github:77:3', now: () => now, leaseTtlMs: 60_000 });
  const observer = storeFor(fake, { ownerId: 'github:88:1', now: () => now, leaseTtlMs: 60_000 });
  const lease = { leaseId: 'lease-1', pid: 123, ownerIdentity: 'github:77:3', createdAt: new Date(now).toISOString() };
  assert.equal(await owner.lockOwnerIsAbandoned(lease), false);
  assert.equal(await observer.lockOwnerIsAbandoned(lease), false);
  now += 61_000;
  assert.equal(await owner.lockOwnerIsAbandoned(lease), false);
  assert.equal(await observer.lockOwnerIsAbandoned(lease), true);
});

test('remote envelope integrity mismatch fails closed with matching epoch authority', async () => {
  const fake = fakeGitHub();
  const store = storeFor(fake);
  const sha = await publishMarker(store, 'one');
  fake.tamperEnvelope(sha, (envelope) => { envelope.state.marker = 'tampered'; });
  await assert.rejects(() => storeFor(fake, { ownerId: 'github:2:1' }).load(), /integrity_mismatch/);
});

