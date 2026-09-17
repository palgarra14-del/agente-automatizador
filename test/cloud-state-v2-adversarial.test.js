import assert from 'node:assert/strict';
import test from 'node:test';
import { URL } from 'node:url';
import { GitHubStateStore } from '../src/cloud-state.js';

function response(status, payload = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return payload; }
  };
}

function fakeGitHub() {
  let sequence = 1000;
  const nextSha = () => (sequence++).toString(16).padStart(40, '0');
  const mainSha = 'a'.repeat(40);
  const mainTree = 'b'.repeat(40);
  const refs = new Map([['refs/heads/main', mainSha]]);
  const commits = new Map([[mainSha, { sha: mainSha, tree: { sha: mainTree }, parents: [] }]]);
  const trees = new Map([[mainTree, new Map()]]);
  const blobs = new Map();
  let lastCreatedCommit = null;
  let failRef = null;
  let raceRef = null;

  const isAncestor = (ancestorSha, descendantSha) => {
    if (ancestorSha === descendantSha) return true;
    const pending = [descendantSha];
    const seen = new Set();
    while (pending.length) {
      const current = pending.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      for (const parent of commits.get(current)?.parents ?? []) {
        if (parent.sha === ancestorSha) return true;
        pending.push(parent.sha);
      }
    }
    return false;
  };

  const fetchImpl = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    const prefix = '/repos/palgarra14-del/agente-automatizador';
    assert.ok(url.pathname.startsWith(prefix));
    const path = url.pathname.slice(prefix.length);
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : null;

    if (method === 'GET' && path.startsWith('/git/ref/')) {
      const ref = `refs/${decodeURIComponent(path.slice('/git/ref/'.length))}`;
      const value = refs.get(ref);
      return value ? response(200, { object: { sha: value } }) : response(404, {});
    }
    if (method === 'GET' && path.startsWith('/git/commits/')) {
      const commit = commits.get(path.slice('/git/commits/'.length));
      return commit ? response(200, commit) : response(404, {});
    }
    if (method === 'GET' && path.startsWith('/compare/')) {
      const [baseSha, headSha] = path.slice('/compare/'.length).split('...');
      if (baseSha === headSha) return response(200, { status: 'identical' });
      if (isAncestor(baseSha, headSha)) return response(200, { status: 'ahead' });
      if (isAncestor(headSha, baseSha)) return response(200, { status: 'behind' });
      return response(200, { status: 'diverged' });
    }
    if (method === 'GET' && path.startsWith('/contents/')) {
      const contentPath = decodeURIComponent(path.slice('/contents/'.length));
      const commitSha = url.searchParams.get('ref');
      assert.match(commitSha ?? '', /^[a-f0-9]{40}$/i);
      const commit = commits.get(commitSha);
      const tree = commit && trees.get(commit.tree.sha);
      const blobSha = tree?.get(contentPath);
      const content = blobSha && blobs.get(blobSha);
      return content
        ? response(200, { type: 'file', encoding: 'base64', content: Buffer.from(content).toString('base64') })
        : response(404, {});
    }
    if (method === 'POST' && path === '/git/blobs') {
      const sha = nextSha();
      blobs.set(sha, body.content);
      return response(201, { sha });
    }
    if (method === 'POST' && path === '/git/trees') {
      const sha = nextSha();
      const tree = new Map(trees.get(body.base_tree) ?? []);
      for (const entry of body.tree) tree.set(entry.path, entry.sha);
      trees.set(sha, tree);
      return response(201, { sha });
    }
    if (method === 'POST' && path === '/git/commits') {
      const sha = nextSha();
      commits.set(sha, {
        sha,
        tree: { sha: body.tree },
        parents: body.parents.map((parent) => ({ sha: parent }))
      });
      lastCreatedCommit = sha;
      return response(201, { sha });
    }
    if (method === 'POST' && path === '/git/refs') {
      if (refs.has(body.ref)) return response(422, {});
      if (failRef === body.ref) {
        failRef = null;
        return response(500, {});
      }
      if (raceRef === body.ref) {
        refs.set(body.ref, body.sha);
        raceRef = null;
        return response(422, {});
      }
      refs.set(body.ref, body.sha);
      return response(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if (method === 'PATCH' && path.startsWith('/git/refs/tags/')) {
      const ref = `refs/tags/${decodeURIComponent(path.slice('/git/refs/tags/'.length))}`;
      if (failRef === ref) {
        failRef = null;
        return response(500, {});
      }
      if (raceRef === ref) {
        refs.set(ref, body.sha);
        raceRef = null;
        return response(422, {});
      }
      const current = refs.get(ref);
      if (!current || body.force !== false || !isAncestor(current, body.sha)) return response(422, {});
      refs.set(ref, body.sha);
      return response(200, { ref, object: { sha: body.sha } });
    }
    throw new Error(`unexpected fake GitHub request: ${method} ${path}`);
  };

  return {
    fetchImpl,
    failNextRefWrite(ref) { failRef = ref; },
    raceNextRefWrite(ref) { raceRef = ref; },
    forceRef(ref, sha) { refs.set(ref, sha); },
    ref(ref) { return refs.get(ref) ?? null; },
    lastCreatedCommit() { return lastCreatedCommit; },
    tamperGeneration(ref, delta) {
      const commit = commits.get(refs.get(ref));
      const tree = trees.get(commit.tree.sha);
      const blobSha = tree.get('.agent/cloud-state.json');
      const envelope = JSON.parse(blobs.get(blobSha));
      envelope.generation += delta;
      blobs.set(blobSha, JSON.stringify(envelope));
    }
  };
}

function storeFor(fake, ownerId) {
  return new GitHubStateStore({
    repository: { owner: 'palgarra14-del', name: 'agente-automatizador' },
    token: 'test-token-not-a-real-secret',
    fetchImpl: fake.fetchImpl,
    ownerId,
    leaseTtlMs: 60_000
  });
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

const stateRef = 'refs/tags/agent-cloud-state-v1';
const checkpointRef = 'refs/tags/agent-cloud-state-v1-checkpoint-v2';

test('fresh process rejects a higher-generation state on divergent Git history', async () => {
  const fake = fakeGitHub();
  const accepted = storeFor(fake, 'github:higher:accepted');
  const seed = await accepted.readSnapshot();
  const seedState = cloneState(seed.state);
  seedState.marker = 'n';
  await accepted.writeSnapshot(seedState, seed);

  const acceptedSnapshot = await accepted.readSnapshot();
  const divergentWriter = storeFor(fake, 'github:higher:divergent');
  const divergentSnapshot = await divergentWriter.readSnapshot();

  fake.failNextRefWrite(stateRef);
  const divergentState = cloneState(divergentSnapshot.state);
  divergentState.marker = 'divergent-n+1';
  await assert.rejects(
    divergentWriter.writeSnapshot(divergentState, divergentSnapshot),
    /cloud_state_github_request_failed:500/
  );
  const divergentN1 = fake.lastCreatedCommit();

  const acceptedState = cloneState(acceptedSnapshot.state);
  acceptedState.marker = 'accepted-n+1';
  const acceptedN1 = await accepted.writeSnapshot(acceptedState, acceptedSnapshot);

  fake.forceRef(stateRef, divergentN1);
  fake.forceRef(checkpointRef, divergentN1);
  const divergentContinuation = storeFor(fake, 'github:higher:continuation');
  const divergentN1Snapshot = await divergentContinuation.readSnapshot();
  const divergentN2State = cloneState(divergentN1Snapshot.state);
  divergentN2State.marker = 'divergent-n+2';
  const divergentN2 = await divergentContinuation.writeSnapshot(divergentN2State, divergentN1Snapshot);

  fake.forceRef(stateRef, divergentN2);
  fake.forceRef(checkpointRef, acceptedN1);
  const fresh = storeFor(fake, 'github:higher:fresh');
  await assert.rejects(fresh.load(), /cloud_state_history_fork/);
});

test('fresh process rejects a descendant whose generation skips the trusted checkpoint sequence', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake, 'github:skip:writer');
  const initial = await writer.readSnapshot();
  const seedState = cloneState(initial.state);
  seedState.marker = 'n';
  await writer.writeSnapshot(seedState, initial);
  const snapshot = await writer.readSnapshot();

  fake.failNextRefWrite(checkpointRef);
  const nextState = cloneState(snapshot.state);
  nextState.marker = 'n+1-state-with-forged-generation';
  await assert.rejects(writer.writeSnapshot(nextState, snapshot), /cloud_state_partial_publication/);
  fake.tamperGeneration(stateRef, 1);

  const fresh = storeFor(fake, 'github:skip:fresh');
  await assert.rejects(fresh.load(), /cloud_state_generation_discontinuity/);
});

test('checkpoint recovery is idempotent when another process wins the same optimistic ref race', async () => {
  const fake = fakeGitHub();
  const writer = storeFor(fake, 'github:race:writer');
  const initial = await writer.readSnapshot();
  const seedState = cloneState(initial.state);
  seedState.marker = 'n';
  await writer.writeSnapshot(seedState, initial);
  const snapshot = await writer.readSnapshot();

  fake.failNextRefWrite(checkpointRef);
  const nextState = cloneState(snapshot.state);
  nextState.marker = 'n+1';
  await assert.rejects(writer.writeSnapshot(nextState, snapshot), /cloud_state_partial_publication/);
  const newestStateSha = fake.ref(stateRef);
  assert.notEqual(newestStateSha, fake.ref(checkpointRef));

  fake.raceNextRefWrite(checkpointRef);
  const fresh = storeFor(fake, 'github:race:fresh');
  const loaded = await fresh.load();
  assert.equal(loaded.marker, 'n+1');
  assert.equal(fake.ref(stateRef), newestStateSha);
  assert.equal(fake.ref(checkpointRef), newestStateSha);
});
