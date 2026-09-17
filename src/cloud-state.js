import { createHash, randomUUID } from 'node:crypto';
import { JsonStore } from './core.js';

const DEFAULT_TAG = 'agent-cloud-state-v1';
const DEFAULT_PATH = '.agent/cloud-state.json';
const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_LEASE_TTL_MS = 20 * 60 * 1000;
const MAX_STATE_HISTORY_DEPTH = 2048;

function sensitiveKey(key) {
  const normalized = String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return /(^|_)(api_key|api_token|access_token|refresh_token|auth_token|github_token|vercel_token|secret|password|credential|authorization|cookie)($|_)/.test(normalized);
}

function containsKnownSecret(value) {
  return /\b(?:gh[pousr]_[A-Za-z0-9_-]+|github_pat_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|vcp_[A-Za-z0-9_-]+)\b/i.test(value) ||
    /\bAuthorization\s*:\s*(?:Basic|Bearer)\s+[^\s,;}"'\]]+/i.test(value);
}

function emptyState() {
  return { runs: {}, approvals: {}, events: [] };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function stateHash(state) {
  return createHash('sha256').update(JSON.stringify(canonical(state))).digest('hex');
}

function assertSha(value, code = 'cloud_state_sha_invalid') {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/i.test(value)) throw new Error(code);
  return value.toLowerCase();
}

function assertNoSensitiveKeys(value, path = 'state') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveKeys(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveKey(key) && child !== null && child !== undefined && child !== '') {
      throw new Error(`cloud_state_sensitive_key:${path}.${key}`);
    }
    assertNoSensitiveKeys(child, `${path}.${key}`);
  }
}

function sanitizeRemoteOnlyEvidence(value) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(sanitizeRemoteOnlyEvidence);
    return;
  }
  if (value.workerEvidence && typeof value.workerEvidence === 'object') {
    delete value.workerEvidence.output;
    delete value.workerEvidence.diagnostics;
  }
  for (const child of Object.values(value)) sanitizeRemoteOnlyEvidence(child);
}

function normalizeAllowedProjectIds(value = ['self']) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw new Error('cloud_state_allowed_projects_invalid');
  const normalized = [...new Set(value.map((projectId) => String(projectId ?? '').trim()))].sort();
  if (normalized.length < 1 || normalized.some((projectId) => !/^[a-z0-9-]{1,80}$/.test(projectId))) {
    throw new Error('cloud_state_allowed_projects_invalid');
  }
  return normalized;
}

function assertProjectOwnership(state, allowedProjectIds) {
  const allowed = new Set(allowedProjectIds);
  const check = (projectId) => {
    if (projectId && !allowed.has(projectId)) throw new Error('cloud_state_project_ownership_mismatch');
  };
  for (const run of Object.values(state.runs ?? {})) check(run?.projectId);
  for (const workflow of Object.values(state.workflows ?? {})) check(workflow?.projectId);
  for (const record of Object.values(state.requests ?? {})) check(record?.request?.projectId ?? record?.projectId ?? null);
}

export function validateCloudState(state, { maxBytes = DEFAULT_MAX_BYTES, allowedProjectIds = ['self'] } = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('cloud_state_invalid');
  const normalizedAllowedProjectIds = normalizeAllowedProjectIds(allowedProjectIds);
  assertProjectOwnership(state, normalizedAllowedProjectIds);
  assertNoSensitiveKeys(state);
  const serialized = JSON.stringify(state);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new Error('cloud_state_too_large');
  if (containsKnownSecret(serialized)) throw new Error('cloud_state_contains_secret_material');
  return state;
}

function responseError(status) {
  if ([409, 422].includes(status)) return new Error('cloud_state_conflict');
  return new Error(`cloud_state_github_request_failed:${status}`);
}

export class GitHubStateStore extends JsonStore {
  constructor({
    repository,
    token = process.env.GITHUB_TOKEN,
    fetchImpl = fetch,
    tag = DEFAULT_TAG,
    checkpointTag = `${tag}-checkpoint-v2`,
    initializationTag = `${checkpointTag}-initialized-v2`,
    statePath = DEFAULT_PATH,
    laneId = 'self',
    allowedProjectIds = ['self'],
    baseBranch = 'main',
    maxBytes = DEFAULT_MAX_BYTES,
    leaseTtlMs = DEFAULT_LEASE_TTL_MS,
    ownerId = process.env.GITHUB_RUN_ID
      ? `github:${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`
      : `cloud:${randomUUID()}`,
    now = () => Date.now()
  } = {}) {
    super('.agent/cloud-state-unused.json');
    if (!repository?.owner || !repository?.name) throw new Error('cloud_state_repository_required');
    if (!/^[A-Za-z0-9._/-]+$/.test(baseBranch) || baseBranch.includes('..')) throw new Error('cloud_state_base_branch_invalid');
    if (!token) throw new Error('cloud_state_github_token_required');
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(tag)) throw new Error('cloud_state_tag_invalid');
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(checkpointTag) || checkpointTag === tag) throw new Error('cloud_state_checkpoint_tag_invalid');
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(initializationTag) || [tag, checkpointTag].includes(initializationTag)) {
      throw new Error('cloud_state_initialization_tag_invalid');
    }
    if (!/^[a-z0-9-]{1,80}$/.test(laneId)) throw new Error('cloud_state_lane_invalid');
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(statePath) || statePath.includes('..')) throw new Error('cloud_state_path_invalid');
    const normalizedAllowedProjectIds = normalizeAllowedProjectIds(allowedProjectIds);
    if (!Number.isInteger(maxBytes) || maxBytes < 16 * 1024 || maxBytes > 2 * 1024 * 1024) throw new Error('cloud_state_max_bytes_invalid');
    if (!Number.isInteger(leaseTtlMs) || leaseTtlMs < 60_000 || leaseTtlMs > 60 * 60 * 1000) throw new Error('cloud_state_lease_ttl_invalid');
    this.repository = repository;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.tag = tag;
    this.checkpointTag = checkpointTag;
    this.initializationTag = initializationTag;
    this.statePath = statePath;
    this.laneId = laneId;
    this.allowedProjectIds = normalizedAllowedProjectIds;
    this.baseBranch = baseBranch;
    this.maxBytes = maxBytes;
    this.leaseTtlMs = leaseTtlMs;
    this.ownerId = ownerId;
    this.now = now;
    this.activeGlobalLeaseId = null;
  }

  apiPath(suffix) {
    return `https://api.github.com/repos/${encodeURIComponent(this.repository.owner)}/${encodeURIComponent(this.repository.name)}${suffix}`;
  }

  async request(suffix, { method = 'GET', body, allow404 = false } = {}) {
    let response;
    try {
      response = await this.fetchImpl(this.apiPath(suffix), {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json'
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: globalThis.AbortSignal.timeout(30_000)
      });
    } catch (error) {
      throw new Error('cloud_state_github_request_failed', { cause: error });
    }
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw responseError(response.status);
    return response.status === 204 ? null : response.json();
  }

  async refSha(ref) {
    const result = await this.request(`/git/ref/${ref}`, { allow404: true });
    if (!result) return null;
    return assertSha(result?.object?.sha, 'cloud_state_ref_invalid');
  }

  async readCommit(sha) {
    const normalized = assertSha(sha);
    const commit = await this.request(`/git/commits/${normalized}`);
    if (assertSha(commit?.sha, 'cloud_state_commit_invalid') !== normalized) throw new Error('cloud_state_commit_invalid');
    if (!Array.isArray(commit.parents)) throw new Error('cloud_state_commit_invalid');
    return commit;
  }

  async compareCommits(baseSha, headSha) {
    const base = assertSha(baseSha);
    const head = assertSha(headSha);
    if (base === head) return 'identical';
    const comparison = await this.request(`/compare/${base}...${head}`);
    if (!['ahead', 'behind', 'diverged', 'identical'].includes(comparison?.status)) throw new Error('cloud_state_compare_invalid');
    return comparison.status;
  }

  async readEnvelopeAt(commitSha) {
    const sha = assertSha(commitSha);
    const encodedPath = this.statePath.split('/').map(encodeURIComponent).join('/');
    const file = await this.request(`/contents/${encodedPath}?ref=${encodeURIComponent(sha)}`);
    if (file?.type !== 'file' || file?.encoding !== 'base64' || typeof file.content !== 'string') throw new Error('cloud_state_file_invalid');
    const raw = Buffer.from(file.content.replace(/\s+/g, ''), 'base64').toString('utf8');
    if (Buffer.byteLength(raw, 'utf8') > this.maxBytes * 2) throw new Error('cloud_state_envelope_too_large');
    let envelope;
    try { envelope = JSON.parse(raw); } catch { throw new Error('cloud_state_envelope_invalid'); }
    if (![1, 2].includes(envelope?.version) ||
        envelope.repository !== `${this.repository.owner}/${this.repository.name}` ||
        !Number.isInteger(envelope.generation) ||
        envelope.generation < 1 ||
        !/^[a-f0-9]{64}$/.test(envelope.stateHash ?? '')) {
      throw new Error('cloud_state_envelope_invalid');
    }
    const persistedLaneId = envelope.laneId ?? 'self';
    if (persistedLaneId !== this.laneId) throw new Error('cloud_state_lane_mismatch');
    if (envelope.version === 2 && (
      envelope.stateTag !== this.tag ||
      envelope.checkpointTag !== this.checkpointTag ||
      envelope.statePath !== this.statePath
    )) {
      throw new Error('cloud_state_ref_binding_mismatch');
    }
    validateCloudState(envelope.state, { maxBytes: this.maxBytes, allowedProjectIds: this.allowedProjectIds });
    if (stateHash(envelope.state) !== envelope.stateHash) throw new Error('cloud_state_integrity_mismatch');
    return envelope;
  }

  async validateHeadContinuity(stateSha, stateEnvelope) {
    const commit = await this.readCommit(stateSha);
    if (commit.parents.length !== 1) throw new Error('cloud_state_history_fork');
    const parentSha = assertSha(commit.parents[0]?.sha, 'cloud_state_parent_invalid');
    if (stateEnvelope.generation === 1) {
      const baseSha = await this.refSha(`heads/${encodeURIComponent(this.baseBranch)}`);
      if (!baseSha) throw new Error('cloud_state_base_branch_missing');
      const baseRelation = await this.compareCommits(parentSha, baseSha);
      if (!['identical', 'ahead'].includes(baseRelation)) throw new Error('cloud_state_bootstrap_ancestry_invalid');
      return;
    }
    const parentEnvelope = await this.readEnvelopeAt(parentSha);
    if (parentEnvelope.generation !== stateEnvelope.generation - 1) throw new Error('cloud_state_generation_discontinuity');
  }

  async validateBootstrapHistory(stateSha, stateEnvelope) {
    let currentSha = stateSha;
    let currentEnvelope = stateEnvelope;
    const visited = new Set();
    for (let depth = 0; depth < MAX_STATE_HISTORY_DEPTH; depth += 1) {
      if (visited.has(currentSha)) throw new Error('cloud_state_history_cycle');
      visited.add(currentSha);
      const commit = await this.readCommit(currentSha);
      if (commit.parents.length !== 1) throw new Error('cloud_state_history_fork');
      const parentSha = assertSha(commit.parents[0]?.sha, 'cloud_state_parent_invalid');
      if (currentEnvelope.generation === 1) {
        const baseSha = await this.refSha(`heads/${encodeURIComponent(this.baseBranch)}`);
        if (!baseSha) throw new Error('cloud_state_base_branch_missing');
        const baseRelation = await this.compareCommits(parentSha, baseSha);
        if (!['identical', 'ahead'].includes(baseRelation)) throw new Error('cloud_state_bootstrap_ancestry_invalid');
        return;
      }
      const parentEnvelope = await this.readEnvelopeAt(parentSha);
      if (parentEnvelope.generation !== currentEnvelope.generation - 1) throw new Error('cloud_state_generation_discontinuity');
      currentSha = parentSha;
      currentEnvelope = parentEnvelope;
    }
    throw new Error('cloud_state_history_too_deep');
  }

  async validateDescendantHistory(checkpointSha, checkpointEnvelope, stateSha, stateEnvelope) {
    if (stateEnvelope.generation === checkpointEnvelope.generation && stateSha !== checkpointSha) {
      throw new Error('cloud_state_same_generation_fork');
    }
    if (stateEnvelope.generation <= checkpointEnvelope.generation) throw new Error('cloud_state_generation_rollback');
    let currentSha = stateSha;
    let currentEnvelope = stateEnvelope;
    const visited = new Set();
    for (let depth = 0; depth < MAX_STATE_HISTORY_DEPTH; depth += 1) {
      if (visited.has(currentSha)) throw new Error('cloud_state_history_cycle');
      visited.add(currentSha);
      const commit = await this.readCommit(currentSha);
      if (commit.parents.length !== 1) throw new Error('cloud_state_history_fork');
      const parentSha = assertSha(commit.parents[0]?.sha, 'cloud_state_parent_invalid');
      if (parentSha === checkpointSha) {
        if (currentEnvelope.generation !== checkpointEnvelope.generation + 1) {
          throw new Error('cloud_state_generation_discontinuity');
        }
        return;
      }
      const parentEnvelope = await this.readEnvelopeAt(parentSha);
      if (parentEnvelope.generation !== currentEnvelope.generation - 1) throw new Error('cloud_state_generation_discontinuity');
      currentSha = parentSha;
      currentEnvelope = parentEnvelope;
    }
    throw new Error('cloud_state_history_too_deep');
  }

  async publishCheckpoint(expectedCheckpointSha, stateSha) {
    if (expectedCheckpointSha) {
      await this.request(`/git/refs/tags/${encodeURIComponent(this.checkpointTag)}`, {
        method: 'PATCH',
        body: { sha: stateSha, force: false }
      });
    } else {
      await this.request('/git/refs', {
        method: 'POST',
        body: { ref: `refs/tags/${this.checkpointTag}`, sha: stateSha }
      });
    }
  }

  async verifyRefs(expectedStateSha, expectedCheckpointSha) {
    const [stateSha, checkpointSha] = await Promise.all([
      this.refSha(`tags/${encodeURIComponent(this.tag)}`),
      this.refSha(`tags/${encodeURIComponent(this.checkpointTag)}`)
    ]);
    return stateSha === expectedStateSha && checkpointSha === expectedCheckpointSha;
  }

  async publishCheckpointAndVerify(expectedCheckpointSha, stateSha, failureCode) {
    let publishError = null;
    try {
      await this.publishCheckpoint(expectedCheckpointSha, stateSha);
    } catch (error) {
      publishError = error;
    }

    let verified = false;
    let verifyError = null;
    try {
      verified = await this.verifyRefs(stateSha, stateSha);
    } catch (error) {
      verifyError = error;
    }
    if (verified) return;
    throw new Error(failureCode, { cause: publishError ?? verifyError ?? undefined });
  }

  async ensureInitializationMarker(trustedSha) {
    const ref = `tags/${encodeURIComponent(this.initializationTag)}`;
    const existingSha = await this.refSha(ref);
    if (existingSha) {
      const relation = await this.compareCommits(existingSha, trustedSha);
      if (!['identical', 'ahead'].includes(relation)) throw new Error('cloud_state_initialization_marker_invalid');
      return existingSha;
    }

    let createError = null;
    try {
      await this.request('/git/refs', {
        method: 'POST',
        body: { ref: `refs/tags/${this.initializationTag}`, sha: trustedSha }
      });
    } catch (error) {
      createError = error;
    }
    const observedSha = await this.refSha(ref);
    if (observedSha === trustedSha) return observedSha;
    throw new Error('cloud_state_initialization_marker_failed', { cause: createError ?? undefined });
  }

  snapshotFrom(sha, checkpointSha, envelope) {
    return {
      refSha: sha,
      checkpointSha,
      generation: envelope.generation,
      state: envelope.state
    };
  }

  async readSnapshot() {
    const [stateSha, checkpointSha, initializationSha] = await Promise.all([
      this.refSha(`tags/${encodeURIComponent(this.tag)}`),
      this.refSha(`tags/${encodeURIComponent(this.checkpointTag)}`),
      this.refSha(`tags/${encodeURIComponent(this.initializationTag)}`)
    ]);

    if (!stateSha && !checkpointSha) {
      if (initializationSha) throw new Error('cloud_state_initialization_marker_orphaned');
      return { refSha: null, checkpointSha: null, generation: 0, state: emptyState() };
    }
    if (!stateSha && checkpointSha) throw new Error('cloud_state_partial_publication');

    const stateEnvelope = await this.readEnvelopeAt(stateSha);
    if (!checkpointSha) {
      if (initializationSha) throw new Error('cloud_state_checkpoint_missing');
      if (stateEnvelope.version === 2 && stateEnvelope.generation !== 1) throw new Error('cloud_state_checkpoint_missing');
      await this.validateBootstrapHistory(stateSha, stateEnvelope);
      const [latestStateSha, latestCheckpointSha, latestInitializationSha] = await Promise.all([
        this.refSha(`tags/${encodeURIComponent(this.tag)}`),
        this.refSha(`tags/${encodeURIComponent(this.checkpointTag)}`),
        this.refSha(`tags/${encodeURIComponent(this.initializationTag)}`)
      ]);
      if (latestStateSha !== stateSha || latestCheckpointSha !== null || latestInitializationSha !== null) {
        throw new Error('cloud_state_conflict');
      }
      await this.publishCheckpointAndVerify(null, stateSha, 'cloud_state_checkpoint_recovery_failed');
      await this.ensureInitializationMarker(stateSha);
      return this.snapshotFrom(stateSha, stateSha, stateEnvelope);
    }

    if (stateSha === checkpointSha) {
      await this.validateHeadContinuity(stateSha, stateEnvelope);
      await this.ensureInitializationMarker(stateSha);
      return this.snapshotFrom(stateSha, checkpointSha, stateEnvelope);
    }

    const checkpointEnvelope = await this.readEnvelopeAt(checkpointSha);
    const relation = await this.compareCommits(checkpointSha, stateSha);
    if (relation === 'behind') throw new Error('cloud_state_rollback');
    if (relation === 'diverged') {
      if (stateEnvelope.generation === checkpointEnvelope.generation) throw new Error('cloud_state_same_generation_fork');
      throw new Error('cloud_state_history_fork');
    }
    if (relation !== 'ahead') throw new Error('cloud_state_history_invalid');
    await this.validateDescendantHistory(checkpointSha, checkpointEnvelope, stateSha, stateEnvelope);
    await this.ensureInitializationMarker(checkpointSha);

    const [latestStateSha, latestCheckpointSha] = await Promise.all([
      this.refSha(`tags/${encodeURIComponent(this.tag)}`),
      this.refSha(`tags/${encodeURIComponent(this.checkpointTag)}`)
    ]);
    if (latestStateSha !== stateSha || latestCheckpointSha !== checkpointSha) throw new Error('cloud_state_conflict');
    await this.publishCheckpointAndVerify(checkpointSha, stateSha, 'cloud_state_checkpoint_recovery_failed');
    return this.snapshotFrom(stateSha, stateSha, stateEnvelope);
  }

  async writeSnapshot(state, snapshot) {
    validateCloudState(state, { maxBytes: this.maxBytes, allowedProjectIds: this.allowedProjectIds });
    const expectedStateSha = snapshot?.refSha ?? null;
    const expectedCheckpointSha = snapshot?.checkpointSha ?? expectedStateSha;
    if ((expectedStateSha === null) !== (expectedCheckpointSha === null)) throw new Error('cloud_state_snapshot_untrusted');

    const trustedSnapshot = await this.readSnapshot();
    if (trustedSnapshot.refSha !== expectedStateSha || trustedSnapshot.checkpointSha !== expectedCheckpointSha) {
      throw new Error('cloud_state_conflict');
    }
    if (snapshot?.generation !== trustedSnapshot.generation) throw new Error('cloud_state_snapshot_untrusted');

    const generation = trustedSnapshot.generation + 1;
    const envelope = {
      version: 2,
      repository: `${this.repository.owner}/${this.repository.name}`,
      laneId: this.laneId,
      stateTag: this.tag,
      checkpointTag: this.checkpointTag,
      statePath: this.statePath,
      generation,
      stateHash: stateHash(state),
      updatedAt: new Date(this.now()).toISOString(),
      state
    };
    const content = JSON.stringify(envelope);
    if (Buffer.byteLength(content, 'utf8') > this.maxBytes * 2) throw new Error('cloud_state_envelope_too_large');

    const parentSha = trustedSnapshot.refSha ?? await this.refSha(`heads/${encodeURIComponent(this.baseBranch)}`);
    if (!parentSha) throw new Error('cloud_state_base_branch_missing');
    const parent = await this.readCommit(parentSha);
    const baseTree = assertSha(parent?.tree?.sha, 'cloud_state_base_tree_invalid');

    const blob = await this.request('/git/blobs', { method: 'POST', body: { content, encoding: 'utf-8' } });
    const tree = await this.request('/git/trees', {
      method: 'POST',
      body: {
        base_tree: baseTree,
        tree: [{ path: this.statePath, mode: '100644', type: 'blob', sha: blob.sha }]
      }
    });
    const commit = await this.request('/git/commits', {
      method: 'POST',
      body: { message: 'Update durable agent cloud state', tree: tree.sha, parents: [parentSha] }
    });
    const commitSha = assertSha(commit?.sha, 'cloud_state_commit_invalid');

    if (trustedSnapshot.refSha) {
      await this.request(`/git/refs/tags/${encodeURIComponent(this.tag)}`, {
        method: 'PATCH',
        body: { sha: commitSha, force: false }
      });
    } else {
      await this.request('/git/refs', {
        method: 'POST',
        body: { ref: `refs/tags/${this.tag}`, sha: commitSha }
      });
    }

    await this.publishCheckpointAndVerify(trustedSnapshot.checkpointSha, commitSha, 'cloud_state_partial_publication');
    await this.ensureInitializationMarker(commitSha);
    return commitSha;
  }

  async load() {
    return (await this.readSnapshot()).state;
  }

  async save() {
    throw new Error('cloud_state_direct_save_forbidden');
  }

  async mutateInternal(mutator, { requireLease }) {
    const snapshot = await this.readSnapshot();
    const data = snapshot.state;
    if (requireLease) {
      const lease = data.cloudExecutionLease;
      const expiresAt = Date.parse(lease?.expiresAt ?? '');
      if (!this.activeGlobalLeaseId ||
          lease?.leaseId !== this.activeGlobalLeaseId ||
          lease?.ownerId !== this.ownerId ||
          !Number.isFinite(expiresAt) ||
          expiresAt <= this.now()) {
        throw new Error('cloud_global_lease_lost');
      }
      lease.expiresAt = new Date(this.now() + this.leaseTtlMs).toISOString();
    }
    const output = await mutator(data);
    sanitizeRemoteOnlyEvidence(data);
    await this.writeSnapshot(data, snapshot);
    return output;
  }

  async mutate(mutator) {
    return this.mutateInternal(mutator, { requireLease: true });
  }

  async ownerIdentity() {
    return this.ownerId;
  }

  async lockOwnerIsAbandoned(metadata) {
    const createdAt = Date.parse(metadata?.createdAt ?? '');
    if (!Number.isFinite(createdAt)) return false;
    if (metadata?.ownerIdentity === this.ownerId) return false;
    return this.now() - createdAt >= this.leaseTtlMs;
  }

  async claimGlobalLease() {
    const lease = {
      leaseId: randomUUID(),
      ownerId: this.ownerId,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + this.leaseTtlMs).toISOString()
    };
    await this.mutateInternal((data) => {
      const existing = data.cloudExecutionLease;
      const existingExpiry = Date.parse(existing?.expiresAt ?? '');
      if (existing && Number.isFinite(existingExpiry) && existingExpiry > this.now()) {
        throw new Error('cloud_global_lease_busy');
      }
      data.cloudExecutionLease = lease;
      return lease;
    }, { requireLease: false });
    this.activeGlobalLeaseId = lease.leaseId;
    return lease;
  }

  async releaseGlobalLease(leaseId) {
    const released = await this.mutateInternal((data) => {
      if (data.cloudExecutionLease?.leaseId !== leaseId || data.cloudExecutionLease?.ownerId !== this.ownerId) return false;
      data.cloudExecutionLease = null;
      return true;
    }, { requireLease: false });
    if (released && this.activeGlobalLeaseId === leaseId) this.activeGlobalLeaseId = null;
    return released;
  }

  async withGlobalLease(operation) {
    const lease = await this.claimGlobalLease();
    let output;
    let operationError = null;
    try { output = await operation(lease); } catch (error) { operationError = error; }
    let released = false;
    let releaseError = null;
    try { released = await this.releaseGlobalLease(lease.leaseId); } catch (error) { releaseError = error; }
    if (releaseError) throw new Error('cloud_global_lease_release_failed', { cause: releaseError });
    if (!released) throw new Error('cloud_global_lease_lost', { cause: operationError ?? undefined });
    if (operationError) throw operationError;
    return output;
  }
}
